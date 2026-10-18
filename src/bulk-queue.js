// Bulk Download Queue Controller
// Strictly sequential at the video level, handles background tab lifecycle,
// capture & stall watchdogs, pause/resume/stop state transitions, and persistent recovery.

import { state, persistStateNow, schedulePersist, updateHistoryRecord } from './state.js';
import { attachCaptureForTab, registerCaptureWaiter, cancelCaptureWaitersForTab } from './capture.js';
import { safePlaybackNudgeFn, DRIVE_SELECTORS } from './single.js';
import { chunkedDownloadFn } from './download-engine.js';
import { ERROR_CODES, getErrorMessage, classifyEngineError } from './errors.js';

export const CAPTURE_TIMEOUT_MS = 45000;
export const STALL_TIMEOUT_MS = 120000;
export const NUDGE_DELAY_MS = 8000;
export const MAX_VIDEO_RETRIES = 2;

export class BulkQueueController {
    constructor({
        tabs = (typeof chrome !== 'undefined' && chrome.tabs) || null,
        debuggerApi = (typeof chrome !== 'undefined' && chrome.debugger) || null,
        downloads = (typeof chrome !== 'undefined' && chrome.downloads) || null,
        scripting = (typeof chrome !== 'undefined' && chrome.scripting) || null,
        clock = {
            setTimeout: (...args) => setTimeout(...args),
            clearTimeout: (...args) => clearTimeout(...args),
            now: () => Date.now()
        },
        stateRef = state,
        persistState = persistStateNow,
        attachCapture = attachCaptureForTab,
        waitCapture = registerCaptureWaiter
    } = {}) {
        this.tabs = tabs;
        this.debuggerApi = debuggerApi;
        this.downloads = downloads;
        this.scripting = scripting;
        this.clock = clock;
        this.stateRef = stateRef;
        this.persistState = persistState;
        this.attachCapture = attachCapture;
        this.waitCapture = waitCapture;

        this.jobToken = 0;
        this.isAdvancing = false;
        this.activeTabId = null;
        this.engineState = 'running'; // 'running' | 'paused'
        this.captureWatchdogTimer = null;
        this.stallWatchdogTimer = null;
        this.nudgeTimer = null;
    }

    get queue() {
        return this.stateRef.bulkQueue;
    }

    initQueue(folderTabId, windowId, destination, videos) {
        const destSnapshot = Object.assign({}, destination || this.stateRef.destination);
        const queueObj = {
            id: 'queue_' + this.clock.now(),
            folderTabId: folderTabId,
            windowId: windowId,
            destination: destSnapshot,
            state: 'idle',
            items: videos.map(v => ({
                fileId: v.fileId,
                name: v.name,
                state: 'queued',
                attempts: 0,
                percent: 0,
                bytes: 0,
                error: null,
                requestId: null
            })),
            index: 0,
            startedAt: this.clock.now(),
            restartedBanner: null
        };

        this.stateRef.bulkQueue = queueObj;
        this.persistState();
        return queueObj;
    }

    async start() {
        if (!this.queue || this.queue.state === 'running') return;
        this.queue.state = 'running';
        this.queue.restartedBanner = null;
        this.persistState();
        await this.advance();
    }

    async pause() {
        if (!this.queue || this.queue.state !== 'running') return;

        this.queue.state = 'pausing';
        this.persistState();

        // Suspend stall watchdog
        if (this.stallWatchdogTimer) {
            this.clock.clearTimeout(this.stallWatchdogTimer);
            this.stallWatchdogTimer = null;
        }

        const activeItem = this.queue.items[this.queue.index];
        if (activeItem && (activeItem.state === 'downloading' || activeItem.state === 'saving') && this.activeTabId) {
            try {
                await this.tabs.sendMessage(this.activeTabId, {
                    type: 'pauseDownload',
                    requestId: activeItem.requestId
                });
            } catch (e) {}
            this.engineState = 'paused';
            activeItem.state = 'paused';
            this.queue.state = 'paused';
            this.persistState();
        } else if (!activeItem || (activeItem.state !== 'capturing' && activeItem.state !== 'opening')) {
            this.queue.state = 'paused';
            this.persistState();
        }
    }

    async resume() {
        if (!this.queue || this.queue.state !== 'paused') return;

        this.queue.state = 'running';
        this.queue.restartedBanner = null;

        const activeItem = this.queue.items[this.queue.index];
        if (activeItem && activeItem.state !== 'completed' && activeItem.state !== 'failed' && activeItem.state !== 'cancelled') {
            if (activeItem.state === 'paused') {
                if (this.activeTabId) {
                    if (activeItem.requestId && this.engineState === 'paused') {
                        activeItem.state = 'downloading';
                        this.engineState = 'running';
                        this.persistState();
                        try {
                            await this.tabs.sendMessage(this.activeTabId, {
                                type: 'resumeDownload',
                                requestId: activeItem.requestId
                            });
                        } catch (e) {}
                        this.resetStallWatchdog();
                    } else if (activeItem.requestId) {
                        activeItem.state = 'downloading';
                        this.engineState = 'running';
                        this.persistState();
                        this.resetStallWatchdog();
                        try {
                            await this.tabs.sendMessage(this.activeTabId, {
                                type: 'resumeDownload',
                                requestId: activeItem.requestId
                            });
                        } catch (e) {}
                    }
                } else {
                    activeItem.state = 'queued';
                    this.persistState();
                    await this.advance();
                }
            } else {
                // In-flight but was paused
                if (this.activeTabId && this.engineState === 'paused' && activeItem.requestId) {
                    this.engineState = 'running';
                    try {
                        await this.tabs.sendMessage(this.activeTabId, {
                            type: 'resumeDownload',
                            requestId: activeItem.requestId
                        });
                    } catch (e) {}
                    this.resetStallWatchdog();
                }
                this.persistState();
            }
        } else {
            this.persistState();
            await this.advance();
        }
    }

    async stop() {
        if (!this.queue || !['running', 'pausing', 'paused'].includes(this.queue.state)) return;

        this.queue.state = 'stopping';
        this.jobToken++; // invalidate in-flight callbacks
        this.clearActiveTimers();

        const activeItem = this.queue.items[this.queue.index];
        if (activeItem && this.activeTabId) {
            try {
                await this.tabs.sendMessage(this.activeTabId, {
                    type: 'cancelDownload',
                    requestId: activeItem.requestId
                });
            } catch (e) {}
        }

        // Cancel any in-flight Chrome download
        if (activeItem && activeItem.requestId && this.stateRef.downloadProgress[activeItem.requestId]) {
            const dlId = this.stateRef.downloadProgress[activeItem.requestId].downloadId;
            if (dlId && this.downloads && this.downloads.cancel) {
                try { await this.downloads.cancel(dlId); } catch (e) {}
            }
        }

        // Mark active and remaining items as cancelled
        this.queue.items.forEach(item => {
            if (item.state !== 'completed' && item.state !== 'failed') {
                item.state = 'cancelled';
                updateHistoryRecord({
                    fileId: item.fileId,
                    name: item.name,
                    status: 'cancelled',
                    attempts: item.attempts,
                    bytes: item.bytes,
                    source: 'bulk'
                });
            }
        });

        // Close ONLY extension-owned tabs
        await this.closeAllOwnedTabs();

        this.queue.state = 'stopped';
        this.persistState();
    }

    clearActiveTimers() {
        if (this.captureWatchdogTimer) {
            this.clock.clearTimeout(this.captureWatchdogTimer);
            this.captureWatchdogTimer = null;
        }
        if (this.stallWatchdogTimer) {
            this.clock.clearTimeout(this.stallWatchdogTimer);
            this.stallWatchdogTimer = null;
        }
        if (this.nudgeTimer) {
            this.clock.clearTimeout(this.nudgeTimer);
            this.nudgeTimer = null;
        }
    }

    resetStallWatchdog() {
        if (this.stallWatchdogTimer) {
            this.clock.clearTimeout(this.stallWatchdogTimer);
            this.stallWatchdogTimer = null;
        }
        if (!this.queue || this.queue.state === 'paused' || this.queue.state === 'stopping') return;

        const currentToken = this.jobToken;
        const currentItem = this.queue.items[this.queue.index];

        this.stallWatchdogTimer = this.clock.setTimeout(async () => {
            if (currentToken !== this.jobToken) return;
            if (!this.queue || this.queue.state === 'paused') return;
            if (!currentItem || currentItem.state !== 'downloading') return;
            await this.handleItemTerminal(currentItem, 'interrupted', 'DOWNLOAD_STALLED', 'DOWNLOAD_STALLED', currentToken);
        }, STALL_TIMEOUT_MS);
    }

    async closeOwnedTab(tabId) {
        if (!tabId) return;

        // Invariant safety assertions
        if (this.queue && tabId === this.queue.folderTabId) {
            throw new Error('CRITICAL_INVARIANT_VIOLATION: Attempted to close origin folder tab');
        }

        if (!this.stateRef.ownedTabs.has(tabId)) {
            return;
        }

        this.stateRef.ownedTabs.delete(tabId);
        if (this.activeTabId === tabId) {
            this.activeTabId = null;
        }

        try {
            if (this.debuggerApi && this.debuggerApi.detach) {
                await this.debuggerApi.detach({ tabId });
            }
        } catch (e) {}

        try {
            if (this.tabs && this.tabs.remove) {
                await this.tabs.remove(tabId);
            }
        } catch (e) {}

        this.persistState();
    }

    async closeAllOwnedTabs() {
        const owned = Array.from(this.stateRef.ownedTabs);
        for (const tid of owned) {
            await this.closeOwnedTab(tid);
        }
        this.activeTabId = null;
    }

    async advance() {
        if (this.isAdvancing) return;
        this.isAdvancing = true;

        try {
            if (!this.queue) return;

            if (this.queue.state === 'pausing') {
                this.queue.state = 'paused';
                this.persistState();
                return;
            }

            if (this.queue.state === 'stopping') {
                this.jobToken++;
                this.queue.state = 'stopped';
                this.persistState();
                return;
            }

            if (this.queue.state !== 'running') {
                return;
            }

            // Find next queued item
            let nextIdx = -1;
            for (let i = 0; i < this.queue.items.length; i++) {
                const it = this.queue.items[i];
                if (it.state === 'queued') {
                    nextIdx = i;
                    break;
                }
            }

            if (nextIdx === -1) {
                this.jobToken++;
                this.queue.state = 'finished';
                await this.closeAllOwnedTabs();
                this.persistState();
                return;
            }

            this.queue.index = nextIdx;
            const item = this.queue.items[nextIdx];
            await this.processItem(item);
        } finally {
            this.isAdvancing = false;
        }
    }

    async processItem(item) {
        this.jobToken++;
        const currentToken = this.jobToken;

        item.state = 'opening';
        item.attempts = (item.attempts || 0) + 1;
        this.engineState = 'running';
        this.persistState();

        this.clearActiveTimers();

        try {
            // Step 1: Create background owned tab
            const tab = await this.tabs.create({
                url: 'about:blank',
                active: false,
                windowId: this.queue.windowId
            });

            if (!tab || !tab.id) {
                throw new Error('FAILED_TO_CREATE_BACKGROUND_TAB');
            }

            // Hard safety check
            if (this.queue && tab.id === this.queue.folderTabId) {
                throw new Error('CRITICAL_INVARIANT_VIOLATION: Background tab equals folder tab');
            }

            this.stateRef.ownedTabs.add(tab.id);
            this.activeTabId = tab.id;
            this.persistState();

            // Attach debugger before navigating so stream request isn't missed
            await this.attachCapture(tab.id);

            // Navigate to video view
            await this.tabs.update(tab.id, {
                url: `https://drive.google.com/file/d/${item.fileId}/view`
            });

            if (currentToken !== this.jobToken) return;

            // Step 2: Capturing phase
            item.state = 'capturing';
            this.persistState();

            // Start capture watchdog (default 45s)
            this.captureWatchdogTimer = this.clock.setTimeout(async () => {
                if (currentToken !== this.jobToken) return;
                // Capture watchdog must never fire during downloading or saving
                if (item.state !== 'capturing') return;
                await this.handleItemTerminal(item, 'interrupted', ERROR_CODES.CAPTURE_TIMEOUT, null, currentToken);
            }, CAPTURE_TIMEOUT_MS);

            // Safe playback nudge after 8s if no capture yet
            this.nudgeTimer = this.clock.setTimeout(async () => {
                if (currentToken !== this.jobToken || item.state !== 'capturing') return;
                try {
                    await this.scripting.executeScript({
                        target: { tabId: tab.id },
                        func: safePlaybackNudgeFn,
                        args: [DRIVE_SELECTORS]
                    });
                } catch (e) {}
            }, NUDGE_DELAY_MS);

            // Register capture waiter
            this.waitCapture(tab.id, item.fileId, (capture) => {
                this.onCaptureResolved(item, currentToken, tab.id, capture);
            }, (err) => {
                if (currentToken !== this.jobToken) return;
                if (item.state === 'capturing') {
                    this.handleItemTerminal(item, 'interrupted', (err && err.message) || ERROR_CODES.CAPTURE_TIMEOUT, null, currentToken);
                }
            }, CAPTURE_TIMEOUT_MS);

        } catch (err) {
            this.clearActiveTimers();
            if (currentToken === this.jobToken) {
                await this.handleItemTerminal(item, 'interrupted', err.message || 'PROCESS_ITEM_FAILED', null, currentToken);
            }
        }
    }

    async onCaptureResolved(item, token, tabId, capture) {
        // Synchronously and immediately clear capture watchdog and nudge timer
        this.clearActiveTimers();

        if (token !== this.jobToken) return;
        if (!this.queue || (this.queue.state !== 'running' && this.queue.state !== 'pausing')) return;

        if (!capture || !capture.lastItagUrl) {
            await this.handleItemTerminal(item, 'interrupted', ERROR_CODES.CAPTURE_TIMEOUT, null, token);
            return;
        }

        // If pause was called while capturing:
        if (this.queue.state === 'pausing') {
            item.state = 'paused';
            item.requestId = capture.requestId;
            this.queue.state = 'paused';
            this.engineState = 'paused';
            this.persistState();
            return;
        }

        // Step 3: Downloading phase
        item.state = 'downloading';
        item.requestId = capture.requestId;
        this.engineState = 'running';
        this.persistState();

        // Progress-stall watchdog
        this.resetStallWatchdog();

        // Inject download engine into the owned tab
        try {
            await this.scripting.executeScript({
                target: { tabId: tabId },
                func: chunkedDownloadFn,
                args: [capture.lastItagUrl, capture.videoTitle || item.name, capture.requestId]
            });
        } catch (err) {
            await this.handleItemTerminal(item, 'interrupted', err.message || 'DOWNLOAD_INIT_FAILED', null, token);
        }
    }

    onEngineEvent(requestId, { status, percent, bytes, completed, total, error } = {}) {
        if (!this.queue) return;
        const activeItem = this.queue.items[this.queue.index];
        if (!activeItem || activeItem.requestId !== requestId) return;

        // Never assign raw engine status to item.state
        if (status === 'starting' || status === 'downloading') {
            if (activeItem.state !== 'paused' && this.queue.state !== 'paused' && this.queue.state !== 'pausing') {
                activeItem.state = 'downloading';
            }
            if (typeof percent === 'number') activeItem.percent = percent;
            if (typeof bytes === 'number') activeItem.bytes = bytes;
            else if (typeof completed === 'number') activeItem.bytes = completed;

            if (activeItem.state === 'downloading') {
                this.resetStallWatchdog();
            }
            schedulePersist();
            return;
        }

        if (status === 'paused') {
            this.engineState = 'paused';
            return;
        }

        if (status === 'saving') {
            activeItem.state = 'saving';
            if (typeof percent === 'number') activeItem.percent = percent;
            if (typeof bytes === 'number') activeItem.bytes = bytes;
            else if (typeof completed === 'number') activeItem.bytes = completed;
            schedulePersist();
            return;
        }

        if (status === 'error') {
            const classified = classifyEngineError(error);
            this.handleItemTerminal(activeItem, 'interrupted', classified, error, this.jobToken);
            return;
        }

        if (status === 'cancelled') {
            if (this.queue.state === 'stopping' || this.queue.state === 'finished' || this.queue.state === 'stopped') {
                return;
            }
            this.handleItemTerminal(activeItem, 'interrupted', 'DOWNLOAD_CANCELLED', error || 'Download cancelled', this.jobToken);
            return;
        }
    }

    onProgressUpdate(requestId, percent, bytes, status) {
        this.onEngineEvent(requestId, { percent, bytes, status });
    }

    async handleItemTerminal(item, resultState, errorReason = null, rawErrorMessage = null, token = null) {
        if (token !== null && token !== undefined && token !== this.jobToken) {
            return;
        }

        if (!item || item.state === 'completed' || item.state === 'failed' || item.state === 'cancelled') {
            return;
        }

        this.clearActiveTimers();

        const currentTabId = this.activeTabId;

        if (resultState === 'completed') {
            item.state = 'completed';
            item.percent = 100;
            item.error = null;
            updateHistoryRecord({
                fileId: item.fileId,
                name: item.name,
                status: 'completed',
                attempts: item.attempts,
                bytes: item.bytes,
                source: 'bulk'
            });
            this.persistState();

            // Terminal tab cleanup: only after complete event
            await this.closeOwnedTab(currentTabId);
            await this.advance();
            return;
        }

        // Failure handling & retries
        const isTransient = (
            errorReason === ERROR_CODES.CAPTURE_TIMEOUT ||
            errorReason === ERROR_CODES.URL_EXPIRED ||
            errorReason === ERROR_CODES.NETWORK_ERROR_RETRYABLE ||
            errorReason === 'NETWORK_ERROR_RETRYABLE' ||
            errorReason === 'DOWNLOAD_STALLED' ||
            errorReason === 'TAB_CLOSED' ||
            errorReason === 'DEBUGGER_DETACHED' ||
            (typeof errorReason === 'string' && errorReason.includes('failed after'))
        );

        await this.closeOwnedTab(currentTabId);

        if (isTransient && (item.attempts || 0) < MAX_VIDEO_RETRIES && (this.queue.state === 'running' || this.queue.state === 'pausing')) {
            item.state = 'queued'; // retry with fresh owned tab
            item.percent = 0;
            item.error = rawErrorMessage || errorReason;
            this.persistState();
            await this.advance();
        } else {
            item.state = 'failed';
            item.error = rawErrorMessage || errorReason || 'DOWNLOAD_FAILED';
            updateHistoryRecord({
                fileId: item.fileId,
                name: item.name,
                status: 'failed',
                error: rawErrorMessage || errorReason || 'DOWNLOAD_FAILED',
                attempts: item.attempts,
                bytes: item.bytes,
                source: 'bulk'
            });
            this.persistState();
            // Failure never blocks the queue; advance to next
            await this.advance();
        }
    }

    async onTabRemoved(tabId) {
        if (this.queue && tabId === this.queue.folderTabId) {
            // Origin folder tab was closed by user; queue continues independently
            this.queue.folderTabId = null;
            return;
        }

        if (this.stateRef.ownedTabs.has(tabId)) {
            this.stateRef.ownedTabs.delete(tabId);
            if (this.activeTabId === tabId) {
                this.activeTabId = null;
                const activeItem = this.queue && this.queue.items[this.queue.index];
                const inFlightStates = ['opening', 'capturing', 'downloading', 'saving', 'paused'];
                if (activeItem && inFlightStates.includes(activeItem.state)) {
                    await this.handleItemTerminal(activeItem, 'interrupted', 'TAB_CLOSED', 'Tab was closed during download', this.jobToken);
                }
            }
        }
    }

    async onDebuggerDetach(tabId, reason) {
        if (this.stateRef.ownedTabs.has(tabId) && this.activeTabId === tabId) {
            const activeItem = this.queue && this.queue.items[this.queue.index];
            const inFlightStates = ['opening', 'capturing', 'downloading', 'saving', 'paused'];
            if (activeItem && inFlightStates.includes(activeItem.state)) {
                await this.handleItemTerminal(activeItem, 'interrupted', reason === 'canceled_by_user' ? 'canceled_by_user' : 'DEBUGGER_DETACHED', 'Debugger detached', this.jobToken);
            }
        }
    }
}

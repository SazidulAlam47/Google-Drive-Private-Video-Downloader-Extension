// Service worker entry point for Drive Private Video Downloader.
// Manages capture, lifecycle listeners, tab state, and message dispatch.

import { state, schedulePersist, persistStateNow, loadPersistedState, countActiveDownloads, clearHistoryRecords, ACTIVE_STATUSES } from './src/state.js';
import { attachCaptureForTab, detachCaptureForTab, detachAllPassiveCaptures, reconcileDebuggerTargets, handleDebuggerDetach, handleDebuggerEvent, extractDriveFileId } from './src/capture.js';
import { chunkedDownloadFn } from './src/download-engine.js';
import { ERROR_CODES, getErrorMessage } from './src/errors.js';
import { buildDownloadPath, sanitizeSubfolder, validateDestination } from './src/settings.js';
import { handleSingleDownload } from './src/single.js';
import { executeFolderScan } from './src/bulk-scan.js';
import { BulkQueueController } from './src/bulk-queue.js';
import { registerCaptureWaiter } from './src/capture.js';
import { DownloadEventsManager } from './src/download-events.js';
import { filterSelectedVideos } from './src/ui-logic.js';

const MAX_CONCURRENT_DOWNLOADS = 3;

// Cached folder scan result ready for bulk start
export let lastScanResult = null;

export async function saveScanResult(result) {
    lastScanResult = result;
    try {
        const storageArea = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) ?
            chrome.storage.session : (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local);
        if (storageArea && storageArea.set) {
            await new Promise((res) => storageArea.set({ lastScanResult: result }, res));
        }
    } catch (e) {}
}

export async function loadScanResult() {
    if (lastScanResult && lastScanResult.timestamp) return lastScanResult;
    try {
        const storageArea = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) ?
            chrome.storage.session : (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local);
        if (storageArea && storageArea.get) {
            const data = await new Promise((res) => storageArea.get('lastScanResult', res));
            if (data && data.lastScanResult) {
                lastScanResult = data.lastScanResult;
                return lastScanResult;
            }
        }
    } catch (e) {}
    return null;
}

// Listeners for download terminal states (used by bulk queue controller)
const downloadTerminalListeners = new Set();
export function registerDownloadTerminalListener(listener) {
    downloadTerminalListeners.add(listener);
    return () => downloadTerminalListeners.delete(listener);
}

// Bulk queue controller instance
export const bulkController = new BulkQueueController({
    tabs: typeof chrome !== 'undefined' ? chrome.tabs : null,
    debuggerApi: typeof chrome !== 'undefined' ? chrome.debugger : null,
    downloads: typeof chrome !== 'undefined' ? chrome.downloads : null,
    scripting: typeof chrome !== 'undefined' ? chrome.scripting : null,
    stateRef: state,
    persistState: persistStateNow,
    attachCapture: attachCaptureForTab,
    waitCapture: registerCaptureWaiter
});

// Download events manager instance
export const downloadEventsManager = new DownloadEventsManager({
    stateRef: state,
    downloads: typeof chrome !== 'undefined' ? chrome.downloads : null,
    tabs: typeof chrome !== 'undefined' ? chrome.tabs : null,
    bulkController: bulkController,
    persistState: persistStateNow,
    schedulePersistRef: schedulePersist,
    onTerminal: (requestId, resultState, errorReason) => {
        downloadTerminalListeners.forEach(listener => {
            try { listener(requestId, resultState, errorReason); } catch (e) {}
        });
    }
});

export const activeDownloads = downloadEventsManager.activeDownloads;

// Register terminal listener for bulk queue
registerDownloadTerminalListener((requestId, resultState, errorReason) => {
    if (bulkController.queue && bulkController.queue.state !== 'finished' && bulkController.queue.state !== 'stopped') {
        const activeItem = bulkController.queue.items[bulkController.queue.index];
        if (activeItem && activeItem.requestId === requestId) {
            bulkController.handleItemTerminal(activeItem, resultState, errorReason, null, bulkController.jobToken);
        }
    }
});

// Configure side panel behavior on startup
if (typeof chrome !== 'undefined' && chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

export function analyzeTabUrl(url, title = '') {
    if (!url || typeof url !== 'string') {
        return { isDrive: false, isVideo: false, isFolder: false, fileId: null, folderId: null, title: title || '' };
    }
    const isDrive = url.startsWith('https://drive.google.com/');
    if (!isDrive) {
        return { isDrive: false, isVideo: false, isFolder: false, fileId: null, folderId: null, title: title || '' };
    }
    const fileIdMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    const folderIdMatch = url.match(/\/drive\/(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]+)/);
    const isRootFolder = url.includes('/drive/my-drive') || (url.includes('/drive/u/') && url.includes('/my-drive'));

    const fileId = fileIdMatch ? fileIdMatch[1] : null;
    const folderId = folderIdMatch ? folderIdMatch[1] : (isRootFolder ? 'root' : null);

    return {
        isDrive: true,
        isVideo: Boolean(fileId),
        isFolder: Boolean(folderId),
        fileId: fileId,
        folderId: folderId,
        title: title || ''
    };
}

export async function updateActiveTabInfo() {
    try {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const tab = tabs[0];
        if (tab) {
            const analysis = analyzeTabUrl(tab.url, tab.title);
            state.activeTabInfo = {
                tabId: tab.id,
                url: tab.url,
                ...analysis
            };
        } else {
            state.activeTabInfo = null;
        }
    } catch (e) {
        state.activeTabInfo = null;
    }
    return state.activeTabInfo;
}

export async function cleanupStartupOwnedTabs(tabsApi = (typeof chrome !== 'undefined' && chrome.tabs), debuggerApi = (typeof chrome !== 'undefined' && chrome.debugger), stateRef = state) {
    if (!tabsApi || !stateRef || !stateRef.ownedTabs || stateRef.ownedTabs.size === 0) return;
    const tabIds = Array.from(stateRef.ownedTabs);
    const folderTabId = stateRef.bulkQueue ? stateRef.bulkQueue.folderTabId : null;

    for (const tabId of tabIds) {
        if (folderTabId && tabId === folderTabId) continue;
        try {
            const tab = await new Promise((resolve) => {
                tabsApi.get(tabId, (t) => {
                    const lastError = (tabsApi.runtime && tabsApi.runtime.lastError) || (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError);
                    if (lastError || !t) resolve(null);
                    else resolve(t);
                });
            });
            if (tab) {
                if (debuggerApi && debuggerApi.detach) {
                    try {
                        await new Promise((resolve) => debuggerApi.detach({ tabId }, () => resolve()));
                    } catch (e) {}
                }
                if (tabsApi.remove) {
                    try {
                        await new Promise((resolve) => tabsApi.remove(tabId, () => resolve()));
                    } catch (e) {}
                }
            }
        } catch (e) {}
    }
    stateRef.ownedTabs.clear();
    persistStateNow();
}

// Startup reconciliation
loadPersistedState(async () => {
    await cleanupStartupOwnedTabs();
    reconcileDebuggerTargets();
    updateActiveTabInfo();
});

// Runtime message listener
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return;

    if (message.type === 'getState') {
        updateActiveTabInfo().then(activeInfo => {
            sendResponse({
                extensionEnabled: state.extensionEnabled,
                requests: state.capturedRequests,
                progress: state.downloadProgress,
                destination: state.destination,
                bulkQueue: state.bulkQueue,
                activeTabInfo: activeInfo,
                history: state.history,
                blobHandoffUnsupported: state.blobHandoffUnsupported
            });
        });
        return true;
    }

    if (message.type === 'getActiveTabInfo') {
        updateActiveTabInfo().then(activeInfo => {
            sendResponse({ activeTabInfo: activeInfo });
        });
        return true;
    }

    // Legacy polling fallback
    if (message.type === 'getRequests') {
        sendResponse(state.capturedRequests);
        return;
    }
    if (message.type === 'getProgress') {
        sendResponse(state.downloadProgress);
        return;
    }

    if (message.type === 'setEnabled') {
        state.extensionEnabled = Boolean(message.enabled);
        persistStateNow();

        if (state.extensionEnabled) {
            chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
                const activeTab = tabs && tabs[0];
                if (!activeTab || !activeTab.id || !activeTab.url || !activeTab.url.startsWith("https://drive.google.com/")) {
                    sendResponse({ success: true, isDriveTab: false });
                    return;
                }
                attachCaptureForTab(activeTab.id)
                    .then(() => sendResponse({ success: true, isDriveTab: true }))
                    .catch((err) => sendResponse({ success: false, error: err.message }));
            });
            return true;
        } else {
            detachAllPassiveCaptures();
            reconcileDebuggerTargets();
            sendResponse({ success: true });
            return;
        }
    }

    if (message.type === 'singleDownload') {
        chrome.tabs.query({ active: true, lastFocusedWindow: true }, async (tabs) => {
            const activeTab = tabs && tabs[0];
            const result = await handleSingleDownload(activeTab);
            sendResponse(result);
        });
        return true;
    }

    if (message.type === 'startDownload') {
        const req = state.capturedRequests[message.requestId];
        if (!req || !req.lastItagUrl) {
            sendResponse({ success: false, error: ERROR_CODES.NO_MEDIA_REQUEST_CAPTURED });
            return;
        }

        const activeCount = countActiveDownloads();
        if (activeCount >= MAX_CONCURRENT_DOWNLOADS) {
            sendResponse({ success: false, error: ERROR_CODES.MAX_CONCURRENT_REACHED, limitReached: true });
            return;
        }

        const currentProg = state.downloadProgress[message.requestId];
        if (currentProg && (currentProg.status === 'starting' || currentProg.status === 'downloading' || currentProg.status === 'saving')) {
            sendResponse({ success: false, error: ERROR_CODES.ALREADY_IN_PROGRESS });
            return;
        }

        state.downloadProgress[message.requestId] = {
            status: 'starting',
            completed: 0,
            total: 0,
            percent: 0,
            error: null,
            title: req.videoTitle || 'Untitled Video',
            lastUpdated: Date.now()
        };
        schedulePersist();

        chrome.scripting.executeScript({
            target: { tabId: req.tabId },
            func: chunkedDownloadFn,
            args: [req.lastItagUrl, req.videoTitle || 'video', req.requestId]
        }).then(() => {
            sendResponse({ success: true });
        }).catch((err) => {
            state.downloadProgress[message.requestId].status = 'interrupted';
            state.downloadProgress[message.requestId].error = err.message;
            persistStateNow();
            sendResponse({ success: false, error: err.message });
        });
        return true;
    }

    if (message.type === 'pauseDownload') {
        const req = state.capturedRequests[message.requestId];
        if (req && req.tabId) {
            try {
                chrome.tabs.sendMessage(req.tabId, {
                    type: 'pauseDownload',
                    requestId: message.requestId
                }, () => { void chrome.runtime.lastError; });
            } catch (e) {}
        }
        sendResponse({ success: true });
        return;
    }

    if (message.type === 'resumeDownload') {
        const req = state.capturedRequests[message.requestId];
        if (req && req.tabId) {
            try {
                chrome.tabs.sendMessage(req.tabId, {
                    type: 'resumeDownload',
                    requestId: message.requestId
                }, () => { void chrome.runtime.lastError; });
            } catch (e) {}
        }
        sendResponse({ success: true });
        return;
    }

    if (message.type === 'cancelDownload') {
        const req = state.capturedRequests[message.requestId];
        if (req && req.tabId) {
            try {
                chrome.tabs.sendMessage(req.tabId, {
                    type: 'cancelDownload',
                    requestId: message.requestId
                }, () => { void chrome.runtime.lastError; });
            } catch (e) {}
        }
        sendResponse({ success: true });
        return;
    }

    if (message.type === 'clearHistory') {
        clearHistoryRecords();
        sendResponse({ success: true });
        return;
    }

    if (message.type === 'downloadProgressUpdate') {
        downloadEventsManager.handleProgressUpdate(message, sender);
        return;
    }

    if (message.type === 'downloadBlobReady') {
        downloadEventsManager.handleBlobReady(message, sender);
        return;
    }

    if (message.type === 'setDestination') {
        if (message.destination) {
            const sub = sanitizeSubfolder(message.destination.subfolder);
            state.destination = {
                mode: message.destination.mode === 'askEachTime' ? 'askEachTime' : 'subfolder',
                subfolder: sub,
                configured: true
            };
            persistStateNow();
        }
        sendResponse({ success: true });
        return;
    }

    if (message.type === 'bulkScan') {
        chrome.tabs.query({ active: true, lastFocusedWindow: true }, async (tabs) => {
            const tab = tabs && tabs[0];
            if (!tab || !tab.id || !tab.url || !tab.url.startsWith('https://drive.google.com/')) {
                sendResponse({
                    success: false,
                    error: ERROR_CODES.NOT_A_DRIVE_FOLDER,
                    message: getErrorMessage(ERROR_CODES.NOT_A_DRIVE_FOLDER)
                });
                return;
            }

            const analysis = analyzeTabUrl(tab.url, tab.title);
            if (!analysis.isFolder) {
                sendResponse({
                    success: false,
                    error: ERROR_CODES.NOT_A_DRIVE_FOLDER,
                    message: getErrorMessage(ERROR_CODES.NOT_A_DRIVE_FOLDER)
                });
                return;
            }

            if (!state.destination.configured) {
                sendResponse({
                    needsDestination: true,
                    destination: state.destination
                });
                return;
            }

            try {
                const report = await executeFolderScan(tab.id);
                lastScanResult = {
                    folderTabId: tab.id,
                    windowId: tab.windowId,
                    report: report,
                    timestamp: Date.now()
                };
                await saveScanResult(lastScanResult);

                sendResponse({
                    success: true,
                    videos: report.videos,
                    totalScanned: report.totalScanned,
                    subfoldersSkipped: report.subfoldersSkipped
                });
            } catch (err) {
                sendResponse({
                    success: false,
                    error: 'FOLDER_SCAN_FAILED',
                    message: err.message
                });
            }
        });
        return true;
    }

    if (message.type === 'bulkStart') {
        loadScanResult().then(async (scan) => {
            const now = Date.now();
            const isFresh = scan && scan.timestamp && (now - scan.timestamp < 10 * 60 * 1000);
            if (!scan || !isFresh) {
                sendResponse({
                    success: false,
                    error: ERROR_CODES.SCAN_STALE_OR_TAB_CLOSED,
                    message: getErrorMessage(ERROR_CODES.SCAN_STALE_OR_TAB_CLOSED)
                });
                return;
            }

            // Verify folder tab still exists
            let tabExists = false;
            try {
                const tab = await new Promise(r => chrome.tabs.get(scan.folderTabId, t => {
                    const lastError = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError);
                    if (lastError || !t) r(null);
                    else r(t);
                }));
                tabExists = Boolean(tab);
            } catch (e) {}

            if (!tabExists) {
                sendResponse({
                    success: false,
                    error: ERROR_CODES.SCAN_STALE_OR_TAB_CLOSED,
                    message: getErrorMessage(ERROR_CODES.SCAN_STALE_OR_TAB_CLOSED)
                });
                return;
            }

            // Verify destination is configured and valid for bulk
            const destValidation = validateDestination(state.destination, true);
            if (!destValidation.valid) {
                sendResponse({
                    success: false,
                    error: destValidation.error,
                    message: getErrorMessage(destValidation.error)
                });
                return;
            }

            // Guard against starting while queue is active
            if (state.bulkQueue && (state.bulkQueue.state === 'running' || state.bulkQueue.state === 'pausing' || state.bulkQueue.state === 'paused' || state.bulkQueue.state === 'stopping')) {
                sendResponse({
                    success: false,
                    error: ERROR_CODES.QUEUE_BUSY,
                    message: getErrorMessage(ERROR_CODES.QUEUE_BUSY)
                });
                return;
            }

            if (!scan.report || !scan.report.videos || !scan.report.videos.length) {
                sendResponse({
                    success: false,
                    error: ERROR_CODES.NO_VIDEOS_IN_FOLDER,
                    message: getErrorMessage(ERROR_CODES.NO_VIDEOS_IN_FOLDER)
                });
                return;
            }

            // Worker-side validation: require selectedFileIds array
            if (!message.selectedFileIds || !Array.isArray(message.selectedFileIds)) {
                sendResponse({
                    success: false,
                    error: ERROR_CODES.NO_VIDEOS_SELECTED,
                    message: getErrorMessage(ERROR_CODES.NO_VIDEOS_SELECTED)
                });
                return;
            }

            const chosenVideos = filterSelectedVideos(scan.report.videos, message.selectedFileIds);
            if (!chosenVideos || chosenVideos.length === 0) {
                sendResponse({
                    success: false,
                    error: ERROR_CODES.NO_VIDEOS_SELECTED,
                    message: getErrorMessage(ERROR_CODES.NO_VIDEOS_SELECTED)
                });
                return;
            }

            bulkController.initQueue(
                scan.folderTabId,
                scan.windowId,
                state.destination,
                chosenVideos
            );

            bulkController.start().catch(() => {});
            sendResponse({ success: true });
        });
        return true;
    }

    if (message.type === 'bulkPause') {
        bulkController.pause().then(() => {
            sendResponse({ success: true });
        });
        return true;
    }

    if (message.type === 'bulkResume') {
        bulkController.resume().then(() => {
            sendResponse({ success: true });
        });
        return true;
    }

    if (message.type === 'bulkStop') {
        bulkController.stop().then(() => {
            sendResponse({ success: true });
        });
        return true;
    }

    if (message.type === 'bulkDismiss') {
        if (state.bulkQueue && (state.bulkQueue.state === 'finished' || state.bulkQueue.state === 'stopped' || state.bulkQueue.state === 'idle')) {
            state.bulkQueue = null;
            persistStateNow();
        }
        sendResponse({ success: true });
        return;
    }

    if (message.type === 'reloadTabAndCapture') {
        const targetTabId = message.tabId || (state.activeTabInfo && state.activeTabInfo.tabId);
        if (targetTabId) {
            chrome.tabs.reload(targetTabId, () => {
                attachCaptureForTab(targetTabId).catch(() => {});
                sendResponse({ success: true });
            });
            return true;
        }
        sendResponse({ success: false });
        return;
    }
    });
}

// Chrome debugger event & detach listeners
if (typeof chrome !== 'undefined' && chrome.debugger) {
    if (chrome.debugger.onEvent) chrome.debugger.onEvent.addListener(handleDebuggerEvent);
    if (chrome.debugger.onDetach) {
        chrome.debugger.onDetach.addListener((debuggeeId, reason) => {
            handleDebuggerDetach(debuggeeId, reason);
            if (debuggeeId && debuggeeId.tabId) {
                bulkController.onDebuggerDetach(debuggeeId.tabId, reason);
            }
        });
    }
}

// Chrome downloads tracking for true completion states
if (typeof chrome !== 'undefined' && chrome.downloads && chrome.downloads.onChanged) {
    chrome.downloads.onChanged.addListener((delta) => {
        downloadEventsManager.handleDownloadChanged(delta);
    });
}

// Tab lifecycle listeners
if (typeof chrome !== 'undefined' && chrome.tabs) {
    if (chrome.tabs.onUpdated) {
        chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
            if (changeInfo.status === "complete" && tab.url && tab.url.startsWith("https://drive.google.com/")) {
                if (state.extensionEnabled && !state.ownedTabs.has(tabId)) {
                    attachCaptureForTab(tabId).catch(() => {});
                }
                updateActiveTabInfo();
            } else if (changeInfo.url && !changeInfo.url.startsWith("https://drive.google.com/")) {
                if (state.attachedTabs.has(tabId) && !state.ownedTabs.has(tabId)) {
                    detachCaptureForTab(tabId);
                }
                updateActiveTabInfo();
            }
        });
    }

    if (chrome.tabs.onActivated) {
        chrome.tabs.onActivated.addListener(() => {
            updateActiveTabInfo();
        });
    }

    if (chrome.tabs.onRemoved) {
        chrome.tabs.onRemoved.addListener((tabId) => {
            bulkController.onTabRemoved(tabId);

            if (state.attachedTabs.has(tabId)) {
                state.attachedTabs.delete(tabId);
            }

            const closedTabRequestIds = new Set();
            Object.keys(state.capturedRequests).forEach(requestId => {
                if (state.capturedRequests[requestId].tabId === tabId) {
                    closedTabRequestIds.add(requestId);
                    delete state.capturedRequests[requestId];
                }
            });

            Object.keys(state.downloadProgress).forEach(rid => {
                if (!closedTabRequestIds.has(rid)) return;
                const p = state.downloadProgress[rid];
                const st = p && p.status;
                if (st && ACTIVE_STATUSES.includes(st)) {
                    p.status = 'interrupted';
                    p.error = 'Tab was closed during download. Click Retry to restart.';
                    p.lastUpdated = Date.now();
                }
            });

            schedulePersist();
            updateActiveTabInfo();
        });
    }
}

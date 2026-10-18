// Download lifecycle event manager
// Handles downloadProgressUpdate, downloadBlobReady, and chrome.downloads.onChanged.
// Manages blob handoff, fallback to anchor, terminal listeners, and history recording.

import { state, persistStateNow, schedulePersist, updateHistoryRecord } from './state.js';
import { ERROR_CODES, getErrorMessage } from './errors.js';
import { buildDownloadPath } from './settings.js';

export class DownloadEventsManager {
    constructor({
        stateRef = state,
        downloads = (typeof chrome !== 'undefined' && chrome.downloads) || null,
        tabs = (typeof chrome !== 'undefined' && chrome.tabs) || null,
        bulkController = null,
        persistState = persistStateNow,
        schedulePersistRef = schedulePersist,
        updateHistory = updateHistoryRecord,
        clock = { now: () => Date.now() },
        onTerminal = null,
        getErrorMessageFn = getErrorMessage,
        buildDownloadPathFn = buildDownloadPath
    } = {}) {
        this.stateRef = stateRef;
        this.downloads = downloads;
        this.tabs = tabs;
        this.bulkController = bulkController;
        this.persistState = persistState;
        this.schedulePersistRef = schedulePersistRef;
        this.updateHistory = updateHistory;
        this.clock = clock;
        this.onTerminal = onTerminal;
        this.getErrorMessageFn = getErrorMessageFn;
        this.buildDownloadPathFn = buildDownloadPathFn;

        this.activeDownloads = new Map(); // downloadId -> { requestId, tabId, blobUrl, filename }
    }

    notifyTerminal(requestId, resultState, errorReason = null) {
        if (typeof this.onTerminal === 'function') {
            try {
                this.onTerminal(requestId, resultState, errorReason);
            } catch (e) {}
        }
    }

    handleProgressUpdate(message, sender) {
        const rid = message.requestId;
        if (!rid) return;

        if (!this.stateRef.downloadProgress[rid]) {
            this.stateRef.downloadProgress[rid] = { status: 'starting', completed: 0, total: 0, percent: 0, error: null };
        }

        if (message.status)                        this.stateRef.downloadProgress[rid].status    = message.status;
        if (typeof message.completed === 'number') this.stateRef.downloadProgress[rid].completed = message.completed;
        if (typeof message.total === 'number')     this.stateRef.downloadProgress[rid].total     = message.total;
        if (typeof message.percent === 'number')   this.stateRef.downloadProgress[rid].percent   = message.percent;
        if (message.error !== undefined)           this.stateRef.downloadProgress[rid].error     = message.error;
        this.stateRef.downloadProgress[rid].lastUpdated = this.clock.now();

        this.schedulePersistRef();

        if (this.bulkController && typeof this.bulkController.onEngineEvent === 'function') {
            this.bulkController.onEngineEvent(rid, message);
        }
    }

    handleBlobReady(message, sender) {
        const { requestId, blobUrl, filename, size } = message;
        if (!requestId) return;

        const req = this.stateRef.capturedRequests[requestId];
        const tabId = req ? req.tabId : (sender && sender.tab ? sender.tab.id : null);
        const isBulk = Boolean(this.bulkController && this.bulkController.queue && this.bulkController.queue.items &&
            this.bulkController.queue.items.some(it => it.requestId === requestId));

        if (!this.stateRef.downloadProgress[requestId]) {
            this.stateRef.downloadProgress[requestId] = {
                status: 'saving',
                completed: size || 0,
                total: size || 0,
                percent: 100,
                error: null
            };
        } else {
            this.stateRef.downloadProgress[requestId].status = 'saving';
            this.stateRef.downloadProgress[requestId].percent = 100;
            this.stateRef.downloadProgress[requestId].lastUpdated = this.clock.now();
        }
        this.persistState();

        if (this.bulkController && typeof this.bulkController.onEngineEvent === 'function') {
            this.bulkController.onEngineEvent(requestId, { status: 'saving', percent: 100, bytes: size });
        }

        const pathInfo = this.buildDownloadPathFn(this.stateRef.destination, filename);
        const targetFilename = pathInfo.filename;
        const saveAs = pathInfo.saveAs;

        const executeFallback = (reason) => {
            if (tabId && this.tabs && typeof this.tabs.sendMessage === 'function') {
                try {
                    this.tabs.sendMessage(tabId, {
                        type: 'saveResult',
                        requestId: requestId,
                        fallbackToAnchor: true
                    }, () => {});
                } catch (e) {}
            }

            this.stateRef.downloadProgress[requestId].status = 'completed';
            this.stateRef.downloadProgress[requestId].note = 'Saved to default Downloads folder (custom folder not applied)';
            this.stateRef.downloadProgress[requestId].error = null;
            this.stateRef.downloadProgress[requestId].lastUpdated = this.clock.now();
            this.persistState();

            this.updateHistory({
                key: (req && req.fileId) || requestId,
                fileId: req && req.fileId,
                name: (req && req.videoTitle) || filename,
                status: 'completed',
                note: 'Saved to default Downloads folder (custom folder not applied)',
                bytes: size || (this.stateRef.downloadProgress[requestId] && this.stateRef.downloadProgress[requestId].completed),
                source: isBulk ? 'bulk' : 'single'
            });

            this.notifyTerminal(requestId, 'completed', null);
        };

        const handleFailure = (errMessage) => {
            const isCancelled = errMessage && (
                errMessage.toLowerCase().includes('cancel') ||
                errMessage.includes('USER_CANCELED') ||
                errMessage.includes('DESTINATION_CANCELLED')
            );

            if (isCancelled) {
                this.stateRef.downloadProgress[requestId].status = 'cancelled';
                this.stateRef.downloadProgress[requestId].error = this.getErrorMessageFn(ERROR_CODES.DESTINATION_CANCELLED);
                this.stateRef.downloadProgress[requestId].lastUpdated = this.clock.now();
                this.persistState();

                if (tabId && this.tabs && typeof this.tabs.sendMessage === 'function') {
                    try {
                        this.tabs.sendMessage(tabId, {
                            type: 'saveResult',
                            requestId: requestId,
                            success: false,
                            error: 'DESTINATION_CANCELLED'
                        }, () => {});
                    } catch (e) {}
                }

                this.updateHistory({
                    key: (req && req.fileId) || requestId,
                    fileId: req && req.fileId,
                    name: (req && req.videoTitle) || filename,
                    status: 'cancelled',
                    error: this.getErrorMessageFn(ERROR_CODES.DESTINATION_CANCELLED),
                    source: isBulk ? 'bulk' : 'single'
                });

                this.notifyTerminal(requestId, 'cancelled', 'DESTINATION_CANCELLED');
            } else {
                this.stateRef.blobHandoffUnsupported = true;
                executeFallback(errMessage);
            }
        };

        // If blob handoff is already marked unsupported, bypass chrome.downloads and go straight to anchor
        if (this.stateRef.blobHandoffUnsupported) {
            executeFallback('BLOB_HANDOFF_UNSUPPORTED');
            return;
        }

        try {
            if (!this.downloads || typeof this.downloads.download !== 'function') {
                handleFailure('DOWNLOADS_API_UNAVAILABLE');
                return;
            }

            this.downloads.download({
                url: blobUrl,
                filename: targetFilename,
                saveAs: saveAs,
                conflictAction: 'uniquify'
            }, (downloadId) => {
                const lastError = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) || null;
                if (lastError || !downloadId) {
                    const msg = (lastError && lastError.message) ? lastError.message : 'DOWNLOAD_INIT_FAILED';
                    handleFailure(msg);
                    return;
                }

                this.activeDownloads.set(downloadId, {
                    requestId,
                    tabId,
                    blobUrl,
                    filename: targetFilename,
                    isBulk
                });

                this.stateRef.downloadProgress[requestId].downloadId = downloadId;
                this.persistState();
            });
        } catch (e) {
            handleFailure(e.message || 'SYNCHRONOUS_DOWNLOAD_EXCEPTION');
        }
    }

    handleDownloadChanged(delta) {
        if (!delta || !this.activeDownloads.has(delta.id)) return;

        const info = this.activeDownloads.get(delta.id);
        const requestId = info.requestId;
        const req = this.stateRef.capturedRequests[requestId];

        if (delta.state) {
            if (delta.state.current === 'complete') {
                this.activeDownloads.delete(delta.id);

                if (this.stateRef.downloadProgress[requestId]) {
                    this.stateRef.downloadProgress[requestId].status = 'completed';
                    this.stateRef.downloadProgress[requestId].percent = 100;
                    this.stateRef.downloadProgress[requestId].lastUpdated = this.clock.now();
                }
                this.persistState();

                if (info.tabId && this.tabs && typeof this.tabs.sendMessage === 'function') {
                    try {
                        this.tabs.sendMessage(info.tabId, {
                            type: 'saveResult',
                            requestId: requestId,
                            success: true
                        }, () => {});
                    } catch (e) {}
                }

                this.updateHistory({
                    key: (req && req.fileId) || requestId,
                    fileId: req && req.fileId,
                    name: (req && req.videoTitle) || info.filename,
                    status: 'completed',
                    bytes: (this.stateRef.downloadProgress[requestId] && this.stateRef.downloadProgress[requestId].completed) || 0,
                    source: info.isBulk ? 'bulk' : 'single'
                });

                this.notifyTerminal(requestId, 'completed', null);

            } else if (delta.state.current === 'interrupted') {
                this.activeDownloads.delete(delta.id);

                const isCancelled = delta.error && delta.error.current === 'USER_CANCELED';
                const status = isCancelled ? 'cancelled' : 'interrupted';
                const error = isCancelled ?
                    this.getErrorMessageFn(ERROR_CODES.DESTINATION_CANCELLED) :
                    (delta.error ? delta.error.current : 'DOWNLOAD_INTERRUPTED');

                if (this.stateRef.downloadProgress[requestId]) {
                    this.stateRef.downloadProgress[requestId].status = status;
                    this.stateRef.downloadProgress[requestId].error = error;
                    this.stateRef.downloadProgress[requestId].lastUpdated = this.clock.now();
                }
                this.persistState();

                if (info.tabId && this.tabs && typeof this.tabs.sendMessage === 'function') {
                    try {
                        this.tabs.sendMessage(info.tabId, {
                            type: 'saveResult',
                            requestId: requestId,
                            success: false,
                            error: error
                        }, () => {});
                    } catch (e) {}
                }

                this.updateHistory({
                    key: (req && req.fileId) || requestId,
                    fileId: req && req.fileId,
                    name: (req && req.videoTitle) || info.filename,
                    status: status,
                    error: error,
                    source: info.isBulk ? 'bulk' : 'single'
                });

                this.notifyTerminal(requestId, status, error);
            }
        }
    }
}

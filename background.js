// Service worker entry point for Drive Private Video Downloader.
// Manages capture, lifecycle listeners, tab state, and message dispatch.

import { state, schedulePersist, persistStateNow, loadPersistedState, countActiveDownloads } from './src/state.js';
import { attachCaptureForTab, detachCaptureForTab, detachAllPassiveCaptures, reconcileDebuggerTargets, handleDebuggerDetach, handleDebuggerEvent, extractDriveFileId } from './src/capture.js';
import { chunkedDownloadFn } from './src/download-engine.js';
import { ERROR_CODES, getErrorMessage } from './src/errors.js';
import { buildDownloadPath, sanitizeSubfolder } from './src/settings.js';
import { handleSingleDownload } from './src/single.js';
import { executeFolderScan } from './src/bulk-scan.js';

const MAX_CONCURRENT_DOWNLOADS = 3;

// Cached folder scan result ready for bulk start
export let lastScanResult = null;

// Map downloadId -> { requestId, tabId, blobUrl, filename }
export const activeDownloads = new Map();

// Listeners for download terminal states (used by bulk queue controller)
const downloadTerminalListeners = new Set();
export function registerDownloadTerminalListener(listener) {
    downloadTerminalListeners.add(listener);
    return () => downloadTerminalListeners.delete(listener);
}

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

// Startup reconciliation
loadPersistedState(() => {
    reconcileDebuggerTargets();
    updateActiveTabInfo();
});

// Runtime message listener
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
                activeTabInfo: activeInfo
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

    if (message.type === 'setEnabled') {
        const targetEnabled = Boolean(message.enabled);
        state.extensionEnabled = targetEnabled;
        persistStateNow();

        if (targetEnabled) {
            // Service worker resolves the active tab itself
            chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
                const tab = tabs[0];
                if (!tab || !tab.url || !tab.url.startsWith('https://drive.google.com/')) {
                    sendResponse({ success: true, isDriveTab: false });
                    return;
                }

                attachCaptureForTab(tab.id)
                    .then(() => {
                        sendResponse({ success: true, isDriveTab: true });
                    })
                    .catch((err) => {
                        sendResponse({ success: false, error: err.message || 'ATTACH_FAILED' });
                    });
            });
            return true;
        } else {
            // OFF must work from any tab: detach all passive captures and reconcile
            detachAllPassiveCaptures();
            sendResponse({ success: true });
            return true;
        }
    }

    if (message.type === 'getRequests') {
        sendResponse({ requests: state.capturedRequests });
        return;
    }

    if (message.type === 'getProgress') {
        sendResponse({ progress: state.downloadProgress });
        return;
    }

    if (message.type === 'startDownload') {
        const requestId = message.requestId;
        const req = state.capturedRequests[requestId];
        if (!req || !req.lastItagUrl) {
            sendResponse({ success: false, error: 'No URL captured for this request.' });
            return;
        }

        const existing = state.downloadProgress[requestId];
        if (existing && (existing.status === 'starting' || existing.status === 'downloading' || existing.status === 'saving' || existing.status === 'paused')) {
            sendResponse({ success: false, error: 'Download already in progress.' });
            return;
        }

        const activeCount = countActiveDownloads();
        if (activeCount >= MAX_CONCURRENT_DOWNLOADS) {
            sendResponse({
                success: false,
                error: getErrorMessage(ERROR_CODES.MAX_CONCURRENT_REACHED),
                limitReached: true
            });
            return;
        }

        state.downloadProgress[requestId] = {
            status: 'starting',
            completed: 0,
            total: 0,
            percent: 0,
            error: null,
            title: req.videoTitle,
            quality: req.quality || '',
            lastUpdated: Date.now()
        };
        persistStateNow();

        chrome.scripting.executeScript({
            target: { tabId: req.tabId },
            func: chunkedDownloadFn,
            args: [req.lastItagUrl, req.videoTitle, requestId]
        }).catch(err => {
            const p = state.downloadProgress[requestId] || {};
            p.status = 'error';
            p.error = (err && err.message) ? err.message : String(err);
            p.lastUpdated = Date.now();
            state.downloadProgress[requestId] = p;
            persistStateNow();
        });

        sendResponse({ success: true });
        return;
    }

    if (message.type === 'pauseDownload' ||
        message.type === 'resumeDownload' ||
        message.type === 'cancelDownload') {

        const rid = message.requestId;
        const req = state.capturedRequests[rid];

        if (state.downloadProgress[rid]) {
            if (message.type === 'pauseDownload') {
                state.downloadProgress[rid].status = 'paused';
            } else if (message.type === 'resumeDownload') {
                state.downloadProgress[rid].status = 'downloading';
            } else if (message.type === 'cancelDownload') {
                state.downloadProgress[rid].status = 'cancelled';
            }
            state.downloadProgress[rid].lastUpdated = Date.now();
            schedulePersist();
        }

        if (req && req.tabId) {
            try {
                chrome.tabs.sendMessage(req.tabId, {
                    type: message.type,
                    requestId: rid
                }, () => { void chrome.runtime.lastError; });
            } catch (e) {}
        }
        sendResponse({ success: true });
        return;
    }

    if (message.type === 'clearHistory') {
        const activeRequestIds = new Set();
        Object.keys(state.downloadProgress).forEach(rid => {
            const st = state.downloadProgress[rid] && state.downloadProgress[rid].status;
            if (st === 'starting' || st === 'downloading' || st === 'saving' || st === 'paused') {
                activeRequestIds.add(rid);
            } else {
                delete state.downloadProgress[rid];
            }
        });

        Object.keys(state.capturedRequests).forEach(rid => {
            if (!activeRequestIds.has(rid)) {
                delete state.capturedRequests[rid];
            }
        });

        persistStateNow();
        sendResponse({ success: true });
        return;
    }

    if (message.type === 'downloadProgressUpdate') {
        const rid = message.requestId;
        if (!state.downloadProgress[rid]) {
            state.downloadProgress[rid] = { status: 'starting', completed: 0, total: 0, percent: 0, error: null };
        }
        if (message.status)  state.downloadProgress[rid].status    = message.status;
        if (typeof message.completed === 'number') state.downloadProgress[rid].completed = message.completed;
        if (typeof message.total     === 'number') state.downloadProgress[rid].total     = message.total;
        if (typeof message.percent   === 'number') state.downloadProgress[rid].percent   = message.percent;
        if (message.error !== undefined)            state.downloadProgress[rid].error     = message.error;
        state.downloadProgress[rid].lastUpdated = Date.now();
        schedulePersist();
        return;
    }

    if (message.type === 'downloadBlobReady') {
        const { requestId, blobUrl, filename, size } = message;
        const req = state.capturedRequests[requestId];
        const tabId = req ? req.tabId : (sender && sender.tab ? sender.tab.id : null);

        const pathInfo = buildDownloadPath(state.destination, filename);
        const targetFilename = pathInfo.filename;
        const saveAs = pathInfo.saveAs;

        if (!state.downloadProgress[requestId]) {
            state.downloadProgress[requestId] = {
                status: 'saving',
                completed: size,
                total: size,
                percent: 100,
                error: null,
                title: filename,
                lastUpdated: Date.now()
            };
        } else {
            state.downloadProgress[requestId].status = 'saving';
            state.downloadProgress[requestId].percent = 100;
            state.downloadProgress[requestId].lastUpdated = Date.now();
        }
        persistStateNow();

        try {
            chrome.downloads.download({
                url: blobUrl,
                filename: targetFilename,
                saveAs: saveAs,
                conflictAction: 'uniquify'
            }, (downloadId) => {
                const err = chrome.runtime.lastError;
                if (err || !downloadId) {
                    const errMsg = (err && err.message) ? err.message : 'DOWNLOAD_INIT_FAILED';
                    const isCancelled = errMsg.toLowerCase().includes('cancel') || errMsg.includes('USER_CANCELED');

                    if (isCancelled) {
                        state.downloadProgress[requestId].status = 'cancelled';
                        state.downloadProgress[requestId].error = getErrorMessage(ERROR_CODES.DESTINATION_CANCELLED);
                        state.downloadProgress[requestId].lastUpdated = Date.now();
                        persistStateNow();

                        if (tabId) {
                            chrome.tabs.sendMessage(tabId, {
                                type: 'saveResult',
                                requestId: requestId,
                                success: false,
                                error: 'DESTINATION_CANCELLED'
                            }, () => void chrome.runtime.lastError);
                        }
                    } else {
                        // Fallback to in-tab anchor save (default Downloads folder)
                        if (tabId) {
                            chrome.tabs.sendMessage(tabId, {
                                type: 'saveResult',
                                requestId: requestId,
                                fallbackToAnchor: true
                            }, () => void chrome.runtime.lastError);
                        }

                        state.downloadProgress[requestId].status = 'completed';
                        state.downloadProgress[requestId].note = 'Saved to default Downloads folder (custom folder not applied)';
                        state.downloadProgress[requestId].lastUpdated = Date.now();
                        state.downloadProgress[requestId].error = null;
                        persistStateNow();
                    }
                    return;
                }

                activeDownloads.set(downloadId, {
                    requestId,
                    tabId,
                    blobUrl,
                    filename: targetFilename
                });

                state.downloadProgress[requestId].downloadId = downloadId;
                persistStateNow();
            });
        } catch (e) {
            // Synchronous error from chrome.downloads.download
            if (tabId) {
                chrome.tabs.sendMessage(tabId, {
                    type: 'saveResult',
                    requestId: requestId,
                    fallbackToAnchor: true
                }, () => void chrome.runtime.lastError);
            }
            state.downloadProgress[requestId].status = 'completed';
            state.downloadProgress[requestId].note = 'Saved to default Downloads folder (custom folder not applied)';
            state.downloadProgress[requestId].lastUpdated = Date.now();
            persistStateNow();
        }
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
        sendResponse({ success: true, destination: state.destination });
        return;
    }

    if (message.type === 'singleDownload') {
        handleSingleDownload().then(res => {
            sendResponse(res);
        }).catch(err => {
            sendResponse({ success: false, error: 'DOWNLOAD_INIT_FAILED', message: err.message });
        });
        return true;
    }

    if (message.type === 'bulkScan') {
        chrome.tabs.query({ active: true, lastFocusedWindow: true }, async (tabs) => {
            const tab = tabs && tabs[0];
            if (!tab || !tab.id || !tab.url) {
                sendResponse({ success: false, error: ERROR_CODES.NOT_A_DRIVE_FOLDER });
                return;
            }

            const isFolderUrl = tab.url.includes('/drive/folders/') || (tab.url.includes('/drive/u/') && tab.url.includes('/folders/')) || tab.url.includes('/drive/my-drive');
            if (!isFolderUrl) {
                sendResponse({ success: false, error: ERROR_CODES.NOT_A_DRIVE_FOLDER });
                return;
            }

            if (!state.destination || state.destination.configured === false) {
                sendResponse({ success: false, needsDestination: true });
                return;
            }

            if (state.destination.mode === 'askEachTime') {
                sendResponse({
                    success: false,
                    needsDestination: true,
                    error: 'BULK_REQUIRES_SUBFOLDER',
                    message: 'Bulk download requires a subfolder destination (Save-As dialog cannot be used for bulk).'
                });
                return;
            }

            try {
                const report = await executeFolderScan(tab.id);
                if (report.videos.length === 0) {
                    sendResponse({
                        success: false,
                        error: ERROR_CODES.NO_VIDEOS_IN_FOLDER,
                        totalScanned: report.totalScanned,
                        subfoldersSkipped: report.subfoldersSkipped
                    });
                    return;
                }

                lastScanResult = {
                    folderTabId: tab.id,
                    windowId: tab.windowId,
                    folderTitle: tab.title || 'Drive Folder',
                    report: report
                };

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

    if (message.type === 'bulkStart' || message.type === 'bulkPause' || message.type === 'bulkResume' || message.type === 'bulkStop') {
        sendResponse({ success: false, error: 'Bulk download not initialized.' });
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

// Chrome debugger event & detach listeners
chrome.debugger.onEvent.addListener(handleDebuggerEvent);
chrome.debugger.onDetach.addListener(handleDebuggerDetach);

// Chrome downloads tracking for true completion states
if (typeof chrome !== 'undefined' && chrome.downloads && chrome.downloads.onChanged) {
    chrome.downloads.onChanged.addListener((delta) => {
        if (!delta || !delta.id) return;
        const active = activeDownloads.get(delta.id);
        if (!active) return;

        const { requestId, tabId } = active;

        if (delta.state) {
            if (delta.state.current === 'complete') {
                if (state.downloadProgress[requestId]) {
                    state.downloadProgress[requestId].status = 'completed';
                    state.downloadProgress[requestId].percent = 100;
                    state.downloadProgress[requestId].error = null;
                    state.downloadProgress[requestId].lastUpdated = Date.now();
                }
                persistStateNow();

                if (tabId) {
                    chrome.tabs.sendMessage(tabId, {
                        type: 'saveResult',
                        requestId: requestId,
                        success: true
                    }, () => void chrome.runtime.lastError);
                }

                activeDownloads.delete(delta.id);

                downloadTerminalListeners.forEach(listener => {
                    try { listener(requestId, 'completed', null); } catch (e) {}
                });
            } else if (delta.state.current === 'interrupted') {
                const errorMsg = delta.error ? (delta.error.current || delta.error) : 'DOWNLOAD_INTERRUPTED';
                if (state.downloadProgress[requestId]) {
                    state.downloadProgress[requestId].status = 'interrupted';
                    state.downloadProgress[requestId].error = String(errorMsg);
                    state.downloadProgress[requestId].lastUpdated = Date.now();
                }
                persistStateNow();

                if (tabId) {
                    chrome.tabs.sendMessage(tabId, {
                        type: 'saveResult',
                        requestId: requestId,
                        success: false,
                        error: String(errorMsg)
                    }, () => void chrome.runtime.lastError);
                }

                activeDownloads.delete(delta.id);

                downloadTerminalListeners.forEach(listener => {
                    try { listener(requestId, 'interrupted', String(errorMsg)); } catch (e) {}
                });
            }
        }
    });
}

// Tab lifecycle listeners
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

chrome.tabs.onActivated.addListener(() => {
    updateActiveTabInfo();
});

chrome.tabs.onRemoved.addListener((tabId) => {
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
        if (st === 'starting' || st === 'downloading' || st === 'saving' || st === 'paused') {
            p.status = 'interrupted';
            p.error = 'Tab was closed during download. Click Retry to restart.';
            p.lastUpdated = Date.now();
        }
    });

    schedulePersist();
    updateActiveTabInfo();
});

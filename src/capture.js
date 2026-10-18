// Debugger capture module for Google Drive video streams.
// Preserves the existing protocol and parsing logic while eliminating
// polling timers, dropping responseBody persistence, and adding robust
// detach handling and startup reconciliation.

import { state, schedulePersist, persistStateNow } from './state.js';

// Waiters waiting for a valid capture event on a tab/fileId
const captureWaiters = new Set();

export function extractDriveFileId(url) {
    if (!url) return null;
    const m = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
    const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m2) return m2[1];
    return null;
}

export function registerCaptureWaiter(tabId, fileId, resolve, reject, timeoutMs = 45000) {
    const waiter = {
        tabId,
        fileId,
        resolve,
        reject,
        timer: null
    };

    if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
            captureWaiters.delete(waiter);
            reject(new Error('CAPTURE_TIMEOUT'));
        }, timeoutMs);
    }

    captureWaiters.add(waiter);

    return () => {
        if (waiter.timer) clearTimeout(waiter.timer);
        captureWaiters.delete(waiter);
    };
}

export function notifyCaptureWaiters(tabId, fileId, capturedReq) {
    for (const waiter of Array.from(captureWaiters)) {
        const matchesTab = (waiter.tabId === tabId);
        const matchesFile = (!waiter.fileId || !fileId || waiter.fileId === fileId);
        if (matchesTab && matchesFile) {
            if (waiter.timer) clearTimeout(waiter.timer);
            captureWaiters.delete(waiter);
            try {
                waiter.resolve(capturedReq);
            } catch (e) {}
        }
    }
}

export function cancelCaptureWaitersForTab(tabId, errorReason = 'DEBUGGER_DETACHED') {
    for (const waiter of Array.from(captureWaiters)) {
        if (waiter.tabId === tabId) {
            if (waiter.timer) clearTimeout(waiter.timer);
            captureWaiters.delete(waiter);
            try {
                waiter.reject(new Error(errorReason));
            } catch (e) {}
        }
    }
}

export function attachCaptureForTab(tabId) {
    return new Promise((resolve, reject) => {
        const debuggee = { tabId };

        if (state.attachedTabs.has(tabId)) {
            resolve({ success: true, alreadyAttached: true });
            return;
        }

        chrome.debugger.attach(debuggee, "1.3", () => {
            const err = chrome.runtime.lastError;
            if (err) {
                reject(new Error(err.message || 'ATTACH_FAILED'));
                return;
            }

            state.attachedTabs.add(tabId);

            chrome.debugger.sendCommand(debuggee, "Network.enable", {}, () => {
                const cmdErr = chrome.runtime.lastError;
                if (cmdErr) {
                    // Detach if Network.enable fails
                    chrome.debugger.detach(debuggee, () => void chrome.runtime.lastError);
                    state.attachedTabs.delete(tabId);
                    reject(new Error(cmdErr.message || 'ATTACH_FAILED'));
                    return;
                }
                resolve({ success: true });
            });
        });
    });
}

export function detachCaptureForTab(tabId) {
    cancelCaptureWaitersForTab(tabId, 'DEBUGGER_DETACHED');
    state.attachedTabs.delete(tabId);
    return new Promise((resolve) => {
        chrome.debugger.detach({ tabId }, () => {
            void chrome.runtime.lastError;
            resolve();
        });
    });
}

export function detachAllPassiveCaptures() {
    const tabsToDetach = Array.from(state.attachedTabs).filter(tid => !state.ownedTabs.has(tid));
    tabsToDetach.forEach(tid => {
        cancelCaptureWaitersForTab(tid, 'DEBUGGER_DETACHED');
        state.attachedTabs.delete(tid);
        chrome.debugger.detach({ tabId: tid }, () => void chrome.runtime.lastError);
    });

    reconcileDebuggerTargets();
}

export function reconcileDebuggerTargets(activeTabsSet = null) {
    if (typeof chrome === 'undefined' || !chrome.debugger || !chrome.debugger.getTargets) {
        return;
    }

    chrome.debugger.getTargets((targets) => {
        if (chrome.runtime.lastError || !Array.isArray(targets)) return;

        targets.forEach(target => {
            if (!target.attached || !target.tabId) return;

            // Do not detach tabs owned by bulk queue
            if (state.ownedTabs.has(target.tabId)) return;

            // If activeTabsSet is provided and contains this tab, keep it
            if (activeTabsSet && activeTabsSet.has(target.tabId)) return;

            // If extension is disabled or tab is not known in attachedTabs, detach
            if (!state.extensionEnabled || !state.attachedTabs.has(target.tabId)) {
                chrome.debugger.detach({ tabId: target.tabId }, () => {
                    void chrome.runtime.lastError;
                });
                state.attachedTabs.delete(target.tabId);
                cancelCaptureWaitersForTab(target.tabId, 'DEBUGGER_DETACHED');
            }
        });
    });
}

export function handleDebuggerDetach(debuggeeId, reason) {
    const tabId = debuggeeId.tabId;
    if (!tabId) return;

    state.attachedTabs.delete(tabId);

    // Fail any waiting capture
    cancelCaptureWaitersForTab(tabId, reason === 'canceled_by_user' ? 'canceled_by_user' : 'target_closed');
}

function findDuplicateRequest(videoTitle, lastItagUrl, excludeRequestId, fileId = null) {
    if (!videoTitle || !lastItagUrl) return null;
    for (const rid in state.capturedRequests) {
        if (rid === excludeRequestId) continue;
        const req = state.capturedRequests[rid];
        if (fileId && req.fileId && req.fileId === fileId) {
            return rid;
        }
        if (req.videoTitle === videoTitle && req.lastItagUrl === lastItagUrl) {
            return rid;
        }
    }
    return null;
}

function findDuplicateByTitle(videoTitle, excludeRequestId, fileId = null) {
    if (!videoTitle) return null;
    for (const rid in state.capturedRequests) {
        if (rid === excludeRequestId) continue;
        const req = state.capturedRequests[rid];
        if (fileId && req.fileId && req.fileId === fileId) {
            return rid;
        }
        if (req.videoTitle === videoTitle) {
            return rid;
        }
    }
    return null;
}

export function handleDebuggerEvent(debuggeeId, method, params) {
    const tabId = debuggeeId.tabId;
    if (!tabId) return;

    const isPassive = state.extensionEnabled && state.attachedTabs.has(tabId);
    const isOwned = state.ownedTabs.has(tabId);
    const isWaiting = Array.from(captureWaiters).some(w => w.tabId === tabId);

    if (!isPassive && !isOwned && !isWaiting) return;

    if (method === "Network.requestWillBeSent") {
        if (params.request.url.startsWith("https://workspacevideo-pa.clients6.google.com")) {
            const requestId = params.requestId;

            // Look up tab's fileId if known
            let fileId = null;
            if (state.activeTabInfo && state.activeTabInfo.tabId === tabId) {
                fileId = state.activeTabInfo.fileId;
            }

            state.capturedRequests[requestId] = {
                requestId: requestId,
                url: params.request.url,
                method: params.request.method,
                timestamp: params.timestamp,
                tabId: tabId,
                fileId: fileId,
                capturedAt: Date.now()
            };
            schedulePersist();
        }
    } else if (method === "Network.responseReceived") {
        const requestId = params.requestId;
        if (state.capturedRequests[requestId]) {
            chrome.debugger.sendCommand(
                { tabId: tabId },
                "Network.getResponseBody",
                { requestId: requestId },
                (result) => {
                    if (chrome.runtime.lastError || !result || !result.body) return;

                    // Note: We deliberately do NOT store result.body in state
                    let newTitle = null;
                    let newUrl = null;
                    let newQuality = null;
                    let newBitrate = null;

                    try {
                        const data = JSON.parse(result.body);
                        const fsd = data.mediaStreamingData && data.mediaStreamingData.formatStreamingData;
                        if (fsd && fsd.progressiveTranscodes && fsd.progressiveTranscodes.length > 0) {
                            const transcodes = fsd.progressiveTranscodes;
                            const last = transcodes[transcodes.length - 1];
                            newUrl = last.url;

                            const meta = last.transcodeMetadata || {};
                            const mimeType = meta.mimeType || '';
                            if (mimeType.startsWith('audio/')) {
                                newQuality = 'AUDIO';
                            } else if (meta.height) {
                                newQuality = meta.height + 'p';
                            } else if (meta.width) {
                                newQuality = meta.width + 'p';
                            } else {
                                newQuality = '';
                            }
                            if (meta.maxContainerBitrate) {
                                newBitrate = meta.maxContainerBitrate;
                            }
                        }
                        if (data.mediaMetadata && data.mediaMetadata.title) {
                            newTitle = data.mediaMetadata.title;
                        }
                    } catch (e) {}

                    const targetReq = state.capturedRequests[requestId];
                    if (!targetReq) return;

                    const fileId = targetReq.fileId;

                    if (newTitle && newUrl) {
                        const dupId = findDuplicateRequest(newTitle, newUrl, requestId, fileId);
                        if (dupId) {
                            const oldReq = state.capturedRequests[dupId];
                            if (oldReq) {
                                oldReq.lastItagUrl = newUrl;
                                if (newQuality !== null) oldReq.quality = newQuality;
                                if (newBitrate) oldReq.bitrate = newBitrate;
                                oldReq.videoTitle = newTitle;
                                if (fileId) oldReq.fileId = fileId;
                            }
                            delete state.capturedRequests[requestId];
                            if (state.downloadProgress[requestId]) {
                                if (!state.downloadProgress[dupId]) {
                                    state.downloadProgress[dupId] = state.downloadProgress[requestId];
                                    state.downloadProgress[dupId].title = newTitle;
                                }
                                delete state.downloadProgress[requestId];
                            }
                            notifyCaptureWaiters(tabId, fileId, oldReq);
                            schedulePersist();
                            return;
                        }

                        const dupTitleId = findDuplicateByTitle(newTitle, requestId, fileId);
                        if (dupTitleId) {
                            const existingProgress = state.downloadProgress[dupTitleId];
                            const keepDupProgress = existingProgress && (
                                existingProgress.status === 'starting' ||
                                existingProgress.status === 'downloading' ||
                                existingProgress.status === 'saving' ||
                                existingProgress.status === 'paused' ||
                                existingProgress.status === 'completed'
                            );

                            if (keepDupProgress) {
                                const oldReq = state.capturedRequests[dupTitleId];
                                if (oldReq) {
                                    oldReq.lastItagUrl = newUrl;
                                    if (newQuality !== null) oldReq.quality = newQuality;
                                    if (newBitrate) oldReq.bitrate = newBitrate;
                                    oldReq.videoTitle = newTitle;
                                    if (fileId) oldReq.fileId = fileId;
                                }
                                delete state.capturedRequests[requestId];
                                notifyCaptureWaiters(tabId, fileId, oldReq);
                                schedulePersist();
                                return;
                            }

                            delete state.capturedRequests[dupTitleId];
                            if (state.downloadProgress[dupTitleId] && !state.downloadProgress[requestId]) {
                                state.downloadProgress[requestId] = state.downloadProgress[dupTitleId];
                                state.downloadProgress[requestId].title = newTitle;
                                delete state.downloadProgress[dupTitleId];
                            } else if (state.downloadProgress[dupTitleId]) {
                                delete state.downloadProgress[dupTitleId];
                            }
                        }
                    }

                    if (newUrl) targetReq.lastItagUrl = newUrl;
                    if (newQuality !== null) targetReq.quality = newQuality;
                    if (newBitrate) targetReq.bitrate = newBitrate;
                    if (newTitle) targetReq.videoTitle = newTitle;

                    if (newUrl && newTitle) {
                        notifyCaptureWaiters(tabId, fileId, targetReq);
                    }

                    schedulePersist();
                }
            );
        }
    }
}

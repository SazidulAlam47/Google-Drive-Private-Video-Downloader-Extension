// Single Download Controller (current tab only; strictly never creates, closes, or reloads a tab)

import { state, schedulePersist, persistStateNow, countActiveDownloads } from './state.js';
import { attachCaptureForTab, registerCaptureWaiter, extractDriveFileId } from './capture.js';
import { chunkedDownloadFn } from './download-engine.js';
import { ERROR_CODES, getErrorMessage } from './errors.js';

const MAX_CONCURRENT_DOWNLOADS = 3;

/**
 * Drive page DOM selectors and heuristics in a centralized constants block.
 */
export const DRIVE_SELECTORS = {
    // Primary HTML5 video element inside Drive preview iframe or main document
    VIDEO: 'video',
    // Drive preview play buttons if video element is not directly autoplayable
    PLAY_BUTTON: 'button[data-tooltip*="Play"], .ytp-play-button, button[aria-label*="Play"], [role="button"][aria-label*="Play"]',
    // Document title containers
    TITLE_CONTAINER: '.drive-viewer-toolstrip-name, [data-target="title"], [role="heading"]'
};

/**
 * Injected safe playback nudge:
 * Sets muted = true, triggers play() if paused, then restores prior state.
 * Never seeks, never navigates, never changes quality.
 */
export function safePlaybackNudgeFn(selectors) {
    try {
        const video = document.querySelector(selectors.VIDEO || 'video');
        if (video) {
            const wasPaused = video.paused;
            const wasMuted = video.muted;
            const prevTime = video.currentTime;

            if (wasPaused) {
                video.muted = true;
                const playPromise = video.play();
                if (playPromise && typeof playPromise.then === 'function') {
                    playPromise.then(() => {
                        setTimeout(() => {
                            try {
                                video.pause();
                                video.muted = wasMuted;
                                video.currentTime = prevTime;
                            } catch (e) {}
                        }, 500);
                    }).catch(() => {
                        try { video.muted = wasMuted; } catch (e) {}
                    });
                }
                return { success: true, method: 'video.play', wasPaused: true };
            }
            return { success: true, method: 'alreadyPlaying', wasPaused: false };
        }

        const playBtn = document.querySelector(selectors.PLAY_BUTTON);
        if (playBtn) {
            playBtn.click();
            setTimeout(() => {
                try {
                    const v = document.querySelector(selectors.VIDEO || 'video');
                    if (v && !v.paused) v.pause();
                } catch (e) {}
            }, 600);
            return { success: true, method: 'playButton.click' };
        }

        return { success: false, error: 'NO_VIDEO_ELEMENT' };
    } catch (e) {
        return { success: false, error: e && e.message ? e.message : String(e) };
    }
}

/**
 * Injected inspection of performance resource entries.
 * Read-only lookup for earlier workspacevideo or videoplayback requests.
 */
export function inspectPerformanceEntriesFn() {
    try {
        const entries = performance.getEntriesByType('resource');
        let matchedUrl = null;

        for (const entry of entries) {
            const url = entry.name;
            if (url.includes('workspacevideo-pa.clients6.google.com')) {
                matchedUrl = url;
                break;
            }
            if (url.includes('videoplayback') && (url.includes('drive.google.com') || url.includes('googleusercontent.com'))) {
                matchedUrl = url;
            }
        }

        const title = document.title ? document.title.replace(/\s*-\s*Google Drive$/i, '').trim() : 'video';

        return {
            found: Boolean(matchedUrl),
            url: matchedUrl,
            title: title
        };
    } catch (e) {
        return { found: false, error: e && e.message ? e.message : String(e) };
    }
}

/**
 * Searches for a valid capture strictly scoped to this tabId and fileId.
 */
export function findValidCaptureForTabAndFile(tabId, fileId, requests) {
    if (!tabId || !fileId || !requests) return null;

    for (const rid in requests) {
        const req = requests[rid];
        if (req.tabId === tabId && req.fileId === fileId && req.lastItagUrl && req.videoTitle) {
            return req;
        }
    }
    return null;
}

/**
 * Executes Single Download workflow with dependency injection for testability.
 */
export async function handleSingleDownload({
    queryTabs = (q) => chrome.tabs.query(q),
    executeScript = (s) => chrome.scripting.executeScript(s),
    attachCapture = attachCaptureForTab,
    waitCapture = registerCaptureWaiter,
    stateRef = state,
    persistNow = persistStateNow,
    schedPersist = schedulePersist
} = {}) {
    // 1. Resolve active tab
    const tabs = await queryTabs({ active: true, lastFocusedWindow: true });
    const tab = tabs && tabs[0];

    if (!tab || !tab.id || !tab.url) {
        return { success: false, error: ERROR_CODES.NO_DRIVE_VIDEO_PAGE };
    }

    const fileId = extractDriveFileId(tab.url);
    if (!fileId) {
        return { success: false, error: ERROR_CODES.NO_DRIVE_VIDEO_PAGE };
    }

    // Safety invariant: Single Download must never add tabs to ownedTabs
    if (stateRef.ownedTabs.has(tab.id)) {
        stateRef.ownedTabs.delete(tab.id);
    }

    // 2. Automatically turn ON if OFF
    if (!stateRef.extensionEnabled) {
        stateRef.extensionEnabled = true;
        persistNow();
    }
    try {
        await attachCapture(tab.id);
    } catch (e) {
        return { success: false, error: ERROR_CODES.ATTACH_FAILED, message: e.message };
    }

    // 3. Destination check
    if (!stateRef.destination || stateRef.destination.configured === false) {
        return {
            success: false,
            needsDestination: true,
            tabId: tab.id,
            fileId: fileId
        };
    }

    // 4. Invalidate old captures on this tab if fileId changed
    for (const rid in stateRef.capturedRequests) {
        const req = stateRef.capturedRequests[rid];
        if (req && req.tabId === tab.id && req.fileId && req.fileId !== fileId) {
            const prog = stateRef.downloadProgress[rid];
            const isDownloading = prog && (prog.status === 'starting' || prog.status === 'downloading' || prog.status === 'saving');
            if (!isDownloading) {
                delete stateRef.capturedRequests[rid];
            }
        }
    }

    // Check if capture already exists
    let capture = findValidCaptureForTabAndFile(tab.id, fileId, stateRef.capturedRequests);

    // 5a. If not found, wait briefly (up to 3s) for in-flight capture events
    if (!capture) {
        try {
            capture = await new Promise((res, rej) => {
                waitCapture(tab.id, fileId, res, rej, 3000);
            });
        } catch (e) {
            capture = null;
        }
    }

    // 5b. Safe playback nudge if still no capture
    if (!capture) {
        try {
            await executeScript({
                target: { tabId: tab.id },
                func: safePlaybackNudgeFn,
                args: [DRIVE_SELECTORS]
            });

            // Wait up to 10s for media request triggered by nudge
            capture = await new Promise((res, rej) => {
                waitCapture(tab.id, fileId, res, rej, 10000);
            });
        } catch (e) {
            capture = null;
        }
    }

    // 5c. Re-derive from performance entries if still no capture
    if (!capture) {
        try {
            const results = await executeScript({
                target: { tabId: tab.id },
                func: inspectPerformanceEntriesFn,
                args: []
            });

            const perfData = results && results[0] && results[0].result;
            if (perfData && perfData.found && perfData.url) {
                const synthId = 'perf_' + tab.id + '_' + Date.now();
                capture = {
                    requestId: synthId,
                    url: perfData.url,
                    lastItagUrl: perfData.url,
                    videoTitle: perfData.title || (tab.title ? tab.title.replace(/\s*-\s*Google Drive$/i, '').trim() : 'video'),
                    quality: '',
                    tabId: tab.id,
                    fileId: fileId,
                    capturedAt: Date.now()
                };
                stateRef.capturedRequests[synthId] = capture;
                schedPersist();
            }
        } catch (e) {
            capture = null;
        }
    }

    // 5d. If still nothing: return NO_MEDIA_REQUEST_CAPTURED with actionable reload option
    if (!capture || !capture.lastItagUrl) {
        return {
            success: false,
            error: ERROR_CODES.NO_MEDIA_REQUEST_CAPTURED,
            tabId: tab.id,
            fileId: fileId
        };
    }

    // 6. Start download using engine in the same tab
    const requestId = capture.requestId;
    const existingProg = stateRef.downloadProgress[requestId];
    if (existingProg && (existingProg.status === 'starting' || existingProg.status === 'downloading' || existingProg.status === 'saving' || existingProg.status === 'paused')) {
        return { success: false, error: ERROR_CODES.ALREADY_IN_PROGRESS };
    }

    const activeCount = countActiveDownloads();
    if (activeCount >= MAX_CONCURRENT_DOWNLOADS) {
        return { success: false, error: ERROR_CODES.MAX_CONCURRENT_REACHED };
    }

    stateRef.downloadProgress[requestId] = {
        status: 'starting',
        completed: 0,
        total: 0,
        percent: 0,
        error: null,
        title: capture.videoTitle,
        quality: capture.quality || '',
        lastUpdated: Date.now()
    };
    persistNow();

    try {
        await executeScript({
            target: { tabId: tab.id },
            func: chunkedDownloadFn,
            args: [capture.lastItagUrl, capture.videoTitle, requestId]
        });
    } catch (err) {
        const p = stateRef.downloadProgress[requestId] || {};
        p.status = 'error';
        p.error = (err && err.message) ? err.message : String(err);
        p.lastUpdated = Date.now();
        stateRef.downloadProgress[requestId] = p;
        persistNow();
        return { success: false, error: 'DOWNLOAD_INIT_FAILED', message: p.error };
    }

    return {
        success: true,
        requestId: requestId,
        title: capture.videoTitle
    };
}

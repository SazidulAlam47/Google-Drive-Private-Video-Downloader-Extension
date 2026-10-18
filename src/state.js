// State management with throttled persistence and startup reconciliation

const STORAGE_KEY_REQUESTS = 'capturedRequests';
const STORAGE_KEY_PROGRESS = 'downloadProgress';
const STORAGE_KEY_ENABLED = 'extensionEnabled';
const STORAGE_KEY_DESTINATION = 'destination';
const STORAGE_KEY_OWNED_TABS = 'ownedTabs';
const STORAGE_KEY_BULK_QUEUE = 'bulkQueue';

export const state = {
    capturedRequests: {},
    downloadProgress: {},
    extensionEnabled: false,
    attachedTabs: new Set(),
    ownedTabs: new Set(),
    destination: {
        mode: 'subfolder',
        subfolder: 'Drive Videos',
        configured: false
    },
    bulkQueue: null,
    activeTabInfo: null
};

let persistTimer = null;
let lastPersistTime = 0;
const MIN_PERSIST_INTERVAL_MS = 500; // max 2 writes per second

export function schedulePersist() {
    const now = Date.now();
    const elapsed = now - lastPersistTime;

    if (persistTimer) return;

    if (elapsed >= MIN_PERSIST_INTERVAL_MS) {
        persistStateNow();
    } else {
        persistTimer = setTimeout(() => {
            persistTimer = null;
            persistStateNow();
        }, MIN_PERSIST_INTERVAL_MS - elapsed);
    }
}

export function persistStateNow() {
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
    lastPersistTime = Date.now();

    // Strip any unexpected large fields like responseBody
    const safeRequests = {};
    for (const [rid, req] of Object.entries(state.capturedRequests)) {
        if (!req) continue;
        safeRequests[rid] = {
            requestId: req.requestId || rid,
            url: req.url,
            method: req.method,
            timestamp: req.timestamp,
            tabId: req.tabId,
            capturedAt: req.capturedAt,
            fileId: req.fileId,
            videoTitle: req.videoTitle,
            lastItagUrl: req.lastItagUrl,
            quality: req.quality,
            bitrate: req.bitrate
        };
    }

    try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({
                [STORAGE_KEY_REQUESTS]: safeRequests,
                [STORAGE_KEY_PROGRESS]: state.downloadProgress,
                [STORAGE_KEY_ENABLED]: state.extensionEnabled,
                [STORAGE_KEY_DESTINATION]: state.destination,
                [STORAGE_KEY_OWNED_TABS]: Array.from(state.ownedTabs),
                [STORAGE_KEY_BULK_QUEUE]: state.bulkQueue
            });
        }
    } catch (e) {
        // Safe catch for headless / tests
    }
}

export function loadPersistedState(callback) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        if (callback) callback();
        return;
    }

    chrome.storage.local.get([
        STORAGE_KEY_REQUESTS,
        STORAGE_KEY_PROGRESS,
        STORAGE_KEY_ENABLED,
        STORAGE_KEY_DESTINATION,
        STORAGE_KEY_OWNED_TABS,
        STORAGE_KEY_BULK_QUEUE
    ], (result) => {
        if (result[STORAGE_KEY_REQUESTS]) {
            state.capturedRequests = result[STORAGE_KEY_REQUESTS];
            // Ensure no responseBody exists
            for (const rid in state.capturedRequests) {
                if (state.capturedRequests[rid] && state.capturedRequests[rid].responseBody) {
                    delete state.capturedRequests[rid].responseBody;
                }
            }
        }

        if (result[STORAGE_KEY_ENABLED] !== undefined) {
            state.extensionEnabled = Boolean(result[STORAGE_KEY_ENABLED]);
        }

        if (result[STORAGE_KEY_DESTINATION]) {
            state.destination = Object.assign({}, state.destination, result[STORAGE_KEY_DESTINATION]);
        }

        if (result[STORAGE_KEY_OWNED_TABS] && Array.isArray(result[STORAGE_KEY_OWNED_TABS])) {
            state.ownedTabs = new Set(result[STORAGE_KEY_OWNED_TABS]);
        }

        if (result[STORAGE_KEY_BULK_QUEUE]) {
            state.bulkQueue = result[STORAGE_KEY_BULK_QUEUE];
            // If service worker restarted while queue was running/pausing, restore as paused
            if (state.bulkQueue && (state.bulkQueue.state === 'running' || state.bulkQueue.state === 'pausing')) {
                state.bulkQueue.state = 'paused';
                state.bulkQueue.restartedBanner = 'The extension restarted. Resume to continue.';
                if (state.bulkQueue.items && typeof state.bulkQueue.index === 'number') {
                    const activeItem = state.bulkQueue.items[state.bulkQueue.index];
                    if (activeItem && activeItem.state !== 'completed' && activeItem.state !== 'failed') {
                        activeItem.state = 'queued';
                    }
                }
            }
        }

        if (result[STORAGE_KEY_PROGRESS]) {
            const now = Date.now();
            Object.keys(result[STORAGE_KEY_PROGRESS]).forEach(rid => {
                const p = result[STORAGE_KEY_PROGRESS][rid];
                if (p && (p.status === 'starting' || p.status === 'downloading' || p.status === 'paused' || p.status === 'saving')) {
                    if (p.lastUpdated && (now - p.lastUpdated) < 24 * 60 * 60 * 1000) {
                        p.status = 'interrupted';
                        p.error = 'Service worker restarted during download. Click Retry to restart.';
                    }
                }
                state.downloadProgress[rid] = p;
            });
        }

        dedupePersistedRequests();

        if (callback) callback();
    });
}

export function dedupePersistedRequests() {
    const seen = {};
    const toDelete = [];
    for (const rid in state.capturedRequests) {
        const req = state.capturedRequests[rid];
        if (!req.videoTitle || !req.lastItagUrl) continue;
        const key = (req.fileId ? (req.fileId + '||') : '') + req.videoTitle + '||' + req.lastItagUrl;
        if (seen[key]) {
            const keepRid = seen[key];
            const keepProgress = state.downloadProgress[keepRid];
            const dropProgress = state.downloadProgress[rid];
            const keepActive = keepProgress && (
                keepProgress.status === 'starting' ||
                keepProgress.status === 'downloading' ||
                keepProgress.status === 'saving' ||
                keepProgress.status === 'paused' ||
                keepProgress.status === 'completed'
            );
            if (keepActive) {
                toDelete.push(rid);
                if (dropProgress) delete state.downloadProgress[rid];
            } else if (dropProgress && !keepProgress) {
                state.downloadProgress[keepRid] = dropProgress;
                delete state.downloadProgress[rid];
                toDelete.push(rid);
            } else {
                toDelete.push(rid);
                if (dropProgress) delete state.downloadProgress[rid];
            }
        } else {
            seen[key] = rid;
        }
    }
    toDelete.forEach(rid => delete state.capturedRequests[rid]);
    if (toDelete.length > 0) {
        persistStateNow();
    }
}

export function countActiveDownloads() {
    let count = 0;
    for (const rid in state.downloadProgress) {
        const st = state.downloadProgress[rid] && state.downloadProgress[rid].status;
        if (st === 'starting' || st === 'downloading' || st === 'saving' || st === 'paused') {
            count++;
        }
    }
    return count;
}

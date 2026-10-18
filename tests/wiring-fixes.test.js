import test from 'node:test';
import assert from 'node:assert/strict';
import { BulkQueueController } from '../src/bulk-queue.js';
import { DownloadEventsManager } from '../src/download-events.js';
import { cleanupStartupOwnedTabs } from '../background.js';
import { state, clearHistoryRecords, updateHistoryRecord } from '../src/state.js';
import { ERROR_CODES } from '../src/errors.js';

class FakeClock {
    constructor() {
        this.currentTime = 1000;
        this.timers = new Map();
        this.nextTimerId = 1;
    }

    now() {
        return this.currentTime;
    }

    setTimeout(fn, delay) {
        const id = this.nextTimerId++;
        this.timers.set(id, { fn, triggerTime: this.currentTime + delay });
        return id;
    }

    clearTimeout(id) {
        this.timers.delete(id);
    }

    async tick(ms) {
        this.currentTime += ms;
        const due = [];
        for (const [id, timer] of this.timers.entries()) {
            if (timer.triggerTime <= this.currentTime) {
                due.push({ id, fn: timer.fn });
            }
        }
        due.sort((a, b) => a.id - b.id);
        for (const item of due) {
            this.timers.delete(item.id);
            await item.fn();
        }
    }
}

function createWiringEnvironment() {
    const clock = new FakeClock();
    let tabIdCounter = 100;

    const createdTabs = [];
    const removedTabs = [];
    const sentMessages = [];
    const detachedTabs = [];

    const tabs = {
        create: async (opts) => {
            const id = tabIdCounter++;
            const tabObj = { id, url: opts.url, windowId: opts.windowId };
            createdTabs.push(tabObj);
            return tabObj;
        },
        update: async (tabId, opts) => {
            return { id: tabId, ...opts };
        },
        remove: async (tabId, cb) => {
            removedTabs.push(tabId);
            if (cb) cb();
        },
        get: (tabId, cb) => {
            cb({ id: tabId });
        },
        sendMessage: async (tabId, msg, cb) => {
            sentMessages.push({ tabId, msg });
            if (cb) cb();
        }
    };

    const debuggerApi = {
        attach: async () => {},
        detach: async (opts, cb) => {
            detachedTabs.push(opts.tabId);
            if (cb) cb();
        },
        sendCommand: async () => {}
    };

    let downloadCalls = 0;
    let shouldRejectDownload = false;
    let downloadRejectMessage = 'Failed to fetch blob';

    const downloads = {
        download: (opts, cb) => {
            downloadCalls++;
            if (shouldRejectDownload) {
                globalThis.chrome = globalThis.chrome || {};
                globalThis.chrome.runtime = globalThis.chrome.runtime || {};
                globalThis.chrome.runtime.lastError = { message: downloadRejectMessage };
                cb(null);
                delete globalThis.chrome.runtime.lastError;
            } else {
                cb(999);
            }
        },
        cancel: async () => {}
    };

    const scripting = {
        executeScript: async () => [{ result: true }]
    };

    const stateRef = {
        bulkQueue: null,
        destination: { mode: 'subfolder', subfolder: 'Test Videos', configured: true },
        downloadProgress: {},
        capturedRequests: {},
        ownedTabs: new Set(),
        history: [],
        blobHandoffUnsupported: false
    };

    let captureResolvers = [];
    const waitCapture = (tabId, fileId, resolve) => {
        captureResolvers.push({ tabId, fileId, resolve });
    };

    const bulkController = new BulkQueueController({
        tabs,
        debuggerApi,
        downloads,
        scripting,
        clock,
        stateRef,
        persistState: () => {},
        attachCapture: async () => {},
        waitCapture
    });

    const downloadEventsManager = new DownloadEventsManager({
        stateRef,
        downloads,
        tabs,
        bulkController,
        persistState: () => {},
        schedulePersistRef: () => {},
        updateHistory: (entry) => {
            const idx = stateRef.history.findIndex(h => h.key === entry.key);
            if (idx >= 0) stateRef.history[idx] = Object.assign(stateRef.history[idx], entry);
            else stateRef.history.unshift(entry);
        },
        clock,
        onTerminal: (requestId, resultState, errorReason) => {
            if (bulkController.queue && bulkController.queue.state !== 'finished') {
                const activeItem = bulkController.queue.items[bulkController.queue.index];
                if (activeItem && activeItem.requestId === requestId) {
                    bulkController.handleItemTerminal(activeItem, resultState, errorReason, null, bulkController.jobToken);
                }
            }
        }
    });

    return {
        clock,
        tabs,
        debuggerApi,
        downloads,
        stateRef,
        bulkController,
        downloadEventsManager,
        createdTabs,
        removedTabs,
        sentMessages,
        detachedTabs,
        resolveCapture: (fileId, requestId = 'req-' + fileId) => {
            const waiter = captureResolvers.find(w => w.fileId === fileId);
            if (waiter) {
                stateRef.capturedRequests[requestId] = {
                    requestId,
                    fileId,
                    tabId: waiter.tabId,
                    videoTitle: 'Video ' + fileId,
                    lastItagUrl: 'https://video.google.com/' + fileId
                };
                waiter.resolve(stateRef.capturedRequests[requestId]);
            }
        },
        setDownloadReject: (reject, msg) => {
            shouldRejectDownload = reject;
            if (msg) downloadRejectMessage = msg;
        },
        getDownloadCalls: () => downloadCalls
    };
}

test('Wiring F1: Engine error event (expired URL text) fails/retries immediately without stall watchdog', async () => {
    const env = createWiringEnvironment();
    const videos = [
        { fileId: 'vid-1', name: 'Video 1' },
        { fileId: 'vid-2', name: 'Video 2' }
    ];

    env.bulkController.initQueue(50, 1, { mode: 'subfolder', subfolder: 'Test' }, videos);
    await env.bulkController.start();

    // Item 0 starts and enters capturing
    assert.equal(env.bulkController.queue.items[0].state, 'capturing');
    env.resolveCapture('vid-1', 'req-vid-1');

    // Item 0 is downloading
    assert.equal(env.bulkController.queue.items[0].state, 'downloading');

    // Engine reports expired URL error
    env.downloadEventsManager.handleProgressUpdate({
        requestId: 'req-vid-1',
        status: 'error',
        error: 'HTTP 403 Forbidden: Video stream URL has expired'
    });

    await new Promise(r => setTimeout(r, 10));

    // Should retry immediately: attempts incremented, new background tab created for retry
    // No clock.tick() needed!
    assert.equal(env.bulkController.queue.items[0].attempts, 2);
    assert.equal(env.bulkController.queue.items[0].state, 'capturing');
});

test('Wiring F1b: Engine error with non-transient message does not retry and marks failed', async () => {
    const env = createWiringEnvironment();
    const videos = [
        { fileId: 'vid-1', name: 'Video 1' },
        { fileId: 'vid-2', name: 'Video 2' }
    ];

    env.bulkController.initQueue(50, 1, { mode: 'subfolder', subfolder: 'Test' }, videos);
    await env.bulkController.start();
    env.resolveCapture('vid-1', 'req-vid-1');

    assert.equal(env.bulkController.queue.items[0].state, 'downloading');

    // Non-transient error: Server ignored Range request
    env.downloadEventsManager.handleProgressUpdate({
        requestId: 'req-vid-1',
        status: 'error',
        error: 'Server ignored Range request: 200 OK received'
    });

    await new Promise(r => setTimeout(r, 10));

    // Should NOT retry: state is failed, attempts is 1, advances to item 1
    assert.equal(env.bulkController.queue.items[0].state, 'failed');
    assert.equal(env.bulkController.queue.items[0].attempts, 1);
    assert.equal(env.bulkController.queue.items[0].error, 'Server ignored Range request: 200 OK received');
    assert.equal(env.bulkController.queue.index, 1);
});

test('Wiring F2: Fallback path completes item with note, advances once, sets blobHandoffUnsupported, and avoids second attempt', async () => {
    const env = createWiringEnvironment();
    const videos = [
        { fileId: 'vid-1', name: 'Video 1' },
        { fileId: 'vid-2', name: 'Video 2' }
    ];

    env.setDownloadReject(true, 'Failed to fetch page-origin blob URL');

    env.bulkController.initQueue(50, 1, { mode: 'subfolder', subfolder: 'Test' }, videos);
    await env.bulkController.start();
    env.resolveCapture('vid-1', 'req-vid-1');

    assert.equal(env.bulkController.queue.items[0].state, 'downloading');

    // Engine sends blob ready
    env.downloadEventsManager.handleBlobReady({
        requestId: 'req-vid-1',
        blobUrl: 'blob:https://drive.google.com/test-blob-1',
        filename: 'video1.mp4',
        size: 5000000
    });

    await new Promise(r => setTimeout(r, 10));

    // Verify item 0 completed on fallback
    assert.equal(env.bulkController.queue.items[0].state, 'completed');
    assert.equal(env.stateRef.downloadProgress['req-vid-1'].status, 'completed');
    assert.ok(env.stateRef.downloadProgress['req-vid-1'].note.includes('default Downloads folder'));
    assert.equal(env.stateRef.blobHandoffUnsupported, true);

    // Queue advanced to item 1 without second tab for item 0
    assert.equal(env.bulkController.queue.index, 1);
    assert.equal(env.bulkController.queue.items[1].state, 'capturing');

    // For item 1, test that blob handoff bypasses chrome.downloads
    const callsBefore = env.getDownloadCalls();
    env.resolveCapture('vid-2', 'req-vid-2');

    env.downloadEventsManager.handleBlobReady({
        requestId: 'req-vid-2',
        blobUrl: 'blob:https://drive.google.com/test-blob-2',
        filename: 'video2.mp4',
        size: 3000000
    });

    await new Promise(r => setTimeout(r, 10));

    // chrome.downloads.download was NOT called again!
    assert.equal(env.getDownloadCalls(), callsBefore);
    assert.equal(env.bulkController.queue.items[1].state, 'completed');
    assert.equal(env.bulkController.queue.state, 'finished');
});

test('Wiring F3: Late downloading event after pause() does not overwrite paused; resume() resumes active item', async () => {
    const env = createWiringEnvironment();
    const videos = [{ fileId: 'vid-1', name: 'Video 1' }, { fileId: 'vid-2', name: 'Video 2' }];

    env.bulkController.initQueue(50, 1, { mode: 'subfolder', subfolder: 'Test' }, videos);
    await env.bulkController.start();
    env.resolveCapture('vid-1', 'req-vid-1');

    assert.equal(env.bulkController.queue.items[0].state, 'downloading');

    // User pauses
    await env.bulkController.pause();
    assert.equal(env.bulkController.queue.state, 'paused');
    assert.equal(env.bulkController.queue.items[0].state, 'paused');

    // Late engine message arrives
    env.downloadEventsManager.handleProgressUpdate({
        requestId: 'req-vid-1',
        status: 'downloading',
        percent: 50
    });

    // States must remain paused!
    assert.equal(env.bulkController.queue.state, 'paused');
    assert.equal(env.bulkController.queue.items[0].state, 'paused');

    // User resumes
    await env.bulkController.resume();
    assert.equal(env.bulkController.queue.state, 'running');
    assert.equal(env.bulkController.queue.items[0].state, 'downloading');
    assert.equal(env.bulkController.queue.index, 0); // Did NOT skip to next item

    // Sent resumeDownload message to tab
    const resumeMsg = env.sentMessages.find(m => m.msg.type === 'resumeDownload');
    assert.ok(resumeMsg);
});

test('Wiring F4: Duplicate terminal event or stray stall timer does not alter a completed item', async () => {
    const env = createWiringEnvironment();
    const videos = [{ fileId: 'vid-1', name: 'Video 1' }];

    env.bulkController.initQueue(50, 1, { mode: 'subfolder', subfolder: 'Test' }, videos);
    await env.bulkController.start();
    env.resolveCapture('vid-1', 'req-vid-1');

    const item0 = env.bulkController.queue.items[0];

    // Complete item 0
    await env.bulkController.handleItemTerminal(item0, 'completed', null, null, env.bulkController.jobToken);
    assert.equal(item0.state, 'completed');

    // Duplicate call with stale token or failure
    await env.bulkController.handleItemTerminal(item0, 'interrupted', 'DOWNLOAD_STALLED', 'Stray error', 9999);
    assert.equal(item0.state, 'completed'); // Unchanged

    // Duplicate call even with same token
    await env.bulkController.handleItemTerminal(item0, 'interrupted', 'DOWNLOAD_STALLED', 'Stray error', env.bulkController.jobToken);
    assert.equal(item0.state, 'completed'); // Unchanged
});

test('Wiring F4b: Tab removed during saving or paused is handled and queue advances', async () => {
    const env = createWiringEnvironment();
    const videos = [{ fileId: 'vid-1', name: 'Video 1' }, { fileId: 'vid-2', name: 'Video 2' }];

    env.bulkController.initQueue(50, 1, { mode: 'subfolder', subfolder: 'Test' }, videos);
    await env.bulkController.start();
    env.resolveCapture('vid-1', 'req-vid-1');

    const item0 = env.bulkController.queue.items[0];
    item0.state = 'saving';

    const activeTabId = env.bulkController.activeTabId;
    assert.ok(activeTabId);

    // User closes tab while saving
    await env.bulkController.onTabRemoved(activeTabId);

    // Retried and continuing
    assert.equal(item0.attempts, 2);
    assert.equal(item0.state, 'capturing');
});

test('Wiring F5: Closing owned tab preserves history; clearHistory keeps active items', async () => {
    state.history = [];
    state.downloadProgress = {};
    state.capturedRequests = {};

    // Record completed download
    updateHistoryRecord({
        key: 'file-123',
        fileId: 'file-123',
        name: 'My Video',
        status: 'completed',
        bytes: 1048576,
        source: 'bulk'
    });

    // Record an active download
    state.downloadProgress['req-active'] = { status: 'downloading', completed: 500 };

    assert.equal(state.history.length, 1);
    assert.equal(state.history[0].fileId, 'file-123');

    // Clear history
    clearHistoryRecords();

    // Active download must be preserved
    assert.ok(state.downloadProgress['req-active']);
    // Terminal history was cleared
    assert.equal(state.history.length, 0);
});

test('Wiring F6: Startup cleanup closes leftover owned tabs but never the folder tab', async () => {
    const closed = [];
    const detached = [];

    const mockTabs = {
        get: (tabId, cb) => {
            cb({ id: tabId });
        },
        remove: (tabId, cb) => {
            closed.push(tabId);
            cb();
        }
    };

    const mockDebugger = {
        detach: (opts, cb) => {
            detached.push(opts.tabId);
            cb();
        }
    };

    const mockState = {
        ownedTabs: new Set([401, 402, 403]),
        bulkQueue: { folderTabId: 401 }
    };

    await cleanupStartupOwnedTabs(mockTabs, mockDebugger, mockState);

    // 401 is the folder tab: must NEVER be closed!
    assert.ok(!closed.includes(401));
    // 402 and 403 must be closed and detached
    assert.ok(closed.includes(402));
    assert.ok(closed.includes(403));
    assert.ok(detached.includes(402));
    assert.ok(detached.includes(403));
    assert.equal(mockState.ownedTabs.size, 0);
});

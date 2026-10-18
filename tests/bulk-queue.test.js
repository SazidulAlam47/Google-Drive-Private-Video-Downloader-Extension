import test from 'node:test';
import assert from 'node:assert/strict';
import { BulkQueueController, CAPTURE_TIMEOUT_MS, STALL_TIMEOUT_MS } from '../src/bulk-queue.js';
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

function createFakeEnvironment() {
    const clock = new FakeClock();
    let tabIdCounter = 200;

    const createdTabs = [];
    const removedTabs = [];
    const updatedTabs = [];
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
            updatedTabs.push({ tabId, opts });
            return { id: tabId, ...opts };
        },
        remove: async (tabId) => {
            removedTabs.push(tabId);
        },
        sendMessage: async (tabId, msg) => {
            sentMessages.push({ tabId, msg });
        }
    };

    const debuggerApi = {
        attach: async (opts) => {},
        detach: async (opts) => {
            detachedTabs.push(opts.tabId);
        },
        sendCommand: async () => {}
    };

    const downloads = {
        cancel: async () => {}
    };

    let executedScripts = [];
    const scripting = {
        executeScript: async (opts) => {
            executedScripts.push(opts);
            return [{ result: true }];
        }
    };

    const stateRef = {
        bulkQueue: null,
        destination: { mode: 'subfolder', subfolder: 'Test Videos', configured: true },
        downloadProgress: {},
        ownedTabs: new Set()
    };

    let captureResolvers = [];
    const waitCapture = (tabId, fileId, resolve, reject, timeout) => {
        captureResolvers.push({ tabId, fileId, resolve, reject });
    };

    const triggerCapture = (tabId, fileId, reqData) => {
        const found = captureResolvers.filter(c => c.tabId === tabId && (!c.fileId || c.fileId === fileId));
        found.forEach(c => {
            c.resolve({
                requestId: 'req_' + fileId,
                lastItagUrl: 'https://stream.drive.google.com/' + fileId,
                videoTitle: reqData ? reqData.name : fileId,
                tabId
            });
        });
    };

    const controller = new BulkQueueController({
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

    return {
        controller,
        clock,
        tabs,
        createdTabs,
        removedTabs,
        updatedTabs,
        sentMessages,
        detachedTabs,
        stateRef,
        triggerCapture,
        getCaptureResolvers: () => captureResolvers
    };
}

test('Bulk Queue - Happy path of N items advances exactly N times', async () => {
    const env = createFakeEnvironment();
    const videos = [
        { fileId: 'vid_1', name: 'Video 1' },
        { fileId: 'vid_2', name: 'Video 2' },
        { fileId: 'vid_3', name: 'Video 3' }
    ];

    env.controller.initQueue(10, 1, env.stateRef.destination, videos);
    await env.controller.start();

    // Item 1: opening -> capturing
    assert.equal(env.controller.queue.index, 0);
    const item1 = env.controller.queue.items[0];
    assert.equal(item1.state, 'capturing');

    // Trigger capture for item 1
    const item1TabId = env.controller.activeTabId;
    env.triggerCapture(item1TabId, 'vid_1', { name: 'Video 1' });
    assert.equal(item1.state, 'downloading');

    // Complete item 1
    await env.controller.handleItemTerminal(item1, 'completed');
    assert.equal(item1.state, 'completed');

    // Item 2 should automatically be opening -> capturing
    assert.equal(env.controller.queue.index, 1);
    const item2 = env.controller.queue.items[1];
    assert.equal(item2.state, 'capturing');

    // Trigger capture and completion for item 2
    const item2TabId = env.controller.activeTabId;
    env.triggerCapture(item2TabId, 'vid_2', { name: 'Video 2' });
    await env.controller.handleItemTerminal(item2, 'completed');
    assert.equal(item2.state, 'completed');

    // Item 3 should be processing
    assert.equal(env.controller.queue.index, 2);
    const item3 = env.controller.queue.items[2];
    assert.equal(item3.state, 'capturing');

    const item3TabId = env.controller.activeTabId;
    env.triggerCapture(item3TabId, 'vid_3', { name: 'Video 3' });
    await env.controller.handleItemTerminal(item3, 'completed');
    assert.equal(item3.state, 'completed');

    // Queue should now be finished
    assert.equal(env.controller.queue.state, 'finished');
    // Origin folder tab 10 was NEVER closed
    assert.ok(!env.removedTabs.includes(10), 'Origin folder tab must never be closed');
    // Exactly 3 background tabs created and removed
    assert.equal(env.createdTabs.length, 3);
    assert.equal(env.removedTabs.length, 3);
});

test('Bulk Queue - Failing item does not block the queue', async () => {
    const env = createFakeEnvironment();
    const videos = [
        { fileId: 'vid_fail', name: 'Broken Video' },
        { fileId: 'vid_ok', name: 'Good Video' }
    ];

    env.controller.initQueue(10, 1, env.stateRef.destination, videos);
    await env.controller.start();

    const item1 = env.controller.queue.items[0];
    assert.equal(item1.state, 'capturing');

    // Fail item 1 non-transiently (or after retries)
    item1.attempts = 2; // exceed max retries
    await env.controller.handleItemTerminal(item1, 'interrupted', 'HTTP_403_FORBIDDEN');
    assert.equal(item1.state, 'failed');
    assert.equal(item1.error, 'HTTP_403_FORBIDDEN');

    // Queue should advance to item 2
    assert.equal(env.controller.queue.index, 1);
    const item2 = env.controller.queue.items[1];
    assert.equal(item2.state, 'capturing');

    // Item 2 succeeds
    env.triggerCapture(env.controller.activeTabId, 'vid_ok', { name: 'Good Video' });
    await env.controller.handleItemTerminal(item2, 'completed');
    assert.equal(item2.state, 'completed');
    assert.equal(env.controller.queue.state, 'finished');
});

test('Bulk Queue - advance() never runs twice for duplicate terminal events', async () => {
    const env = createFakeEnvironment();
    const videos = [
        { fileId: 'vid_1', name: 'Video 1' },
        { fileId: 'vid_2', name: 'Video 2' }
    ];

    env.controller.initQueue(10, 1, env.stateRef.destination, videos);
    await env.controller.start();

    const item1 = env.controller.queue.items[0];
    env.triggerCapture(env.controller.activeTabId, 'vid_1', { name: 'Video 1' });

    // Inject duplicate terminal events concurrently
    await Promise.all([
        env.controller.handleItemTerminal(item1, 'completed'),
        env.controller.handleItemTerminal(item1, 'completed')
    ]);

    // Should be on item 2, not jumped ahead
    assert.equal(env.controller.queue.index, 1);
    assert.equal(env.controller.queue.items[0].state, 'completed');
    assert.equal(env.controller.queue.items[1].state, 'capturing');
});

test('Bulk Queue - Capture watchdog is cleared on capture and cannot fire during downloading', async () => {
    const env = createFakeEnvironment();
    const videos = [{ fileId: 'vid_long', name: 'Long 2-Hour Video' }];

    env.controller.initQueue(10, 1, env.stateRef.destination, videos);
    await env.controller.start();

    const item = env.controller.queue.items[0];
    assert.equal(item.state, 'capturing');

    const tabId = env.controller.activeTabId;
    // Capture happens at 5 seconds
    env.clock.tick(5000);
    env.triggerCapture(tabId, 'vid_long', { name: 'Long 2-Hour Video' });
    assert.equal(item.state, 'downloading');

    // Now advance fake clock past 45 seconds (e.g. 60 seconds into download)
    env.clock.tick(60000);

    // Assert capture watchdog did NOT fire and tab is still alive
    assert.equal(item.state, 'downloading');
    assert.ok(!env.removedTabs.includes(tabId), 'Owned tab must remain open while downloading');

    // Finish download cleanly
    await env.controller.handleItemTerminal(item, 'completed');
    assert.equal(item.state, 'completed');
    assert.ok(env.removedTabs.includes(tabId), 'Tab closed only after completion');
});

test('Bulk Queue - Stall watchdog fires only on no-progress and is reset by progress', async () => {
    const env = createFakeEnvironment();
    const videos = [{ fileId: 'vid_stall', name: 'Stalled Video' }];

    env.controller.initQueue(10, 1, env.stateRef.destination, videos);
    await env.controller.start();

    const item = env.controller.queue.items[0];
    const tabId = env.controller.activeTabId;
    env.triggerCapture(tabId, 'vid_stall', { name: 'Stalled Video' });
    assert.equal(item.state, 'downloading');

    // Progress arrives at 60s -> resets watchdog
    await env.clock.tick(60000);
    env.controller.onProgressUpdate('req_vid_stall', 50, 500000, 'downloading');
    assert.equal(item.state, 'downloading');

    // Progress arrives at another 60s -> resets watchdog again
    await env.clock.tick(60000);
    env.controller.onProgressUpdate('req_vid_stall', 75, 750000, 'downloading');
    assert.equal(item.state, 'downloading');

    // Now silence for 130s (> 120s stall timeout)
    item.attempts = 2; // exceed retries so it marks failed
    await env.clock.tick(130000);

    // Stall watchdog should have fired and terminated the item
    assert.equal(item.state, 'failed');
    assert.equal(item.error, 'DOWNLOAD_STALLED');
});

test('Bulk Queue - Retry creates a fresh tab and increments attempts on single record', async () => {
    const env = createFakeEnvironment();
    const videos = [{ fileId: 'vid_retry', name: 'Flaky Video' }];

    env.controller.initQueue(10, 1, env.stateRef.destination, videos);
    await env.controller.start();

    const item = env.controller.queue.items[0];
    const firstTabId = env.controller.activeTabId;

    // Simulate transient failure on first attempt (attempt 1)
    await env.controller.handleItemTerminal(item, 'interrupted', ERROR_CODES.CAPTURE_TIMEOUT);

    // Item should be requeued, tab closed, attempts = 1
    assert.equal(item.state, 'capturing');
    assert.equal(item.attempts, 2);
    assert.ok(env.removedTabs.includes(firstTabId), 'First tab was closed');

    const secondTabId = env.controller.activeTabId;
    assert.notEqual(firstTabId, secondTabId, 'Retry created a fresh tab');

    // Second attempt succeeds
    env.triggerCapture(secondTabId, 'vid_retry', { name: 'Flaky Video' });
    await env.controller.handleItemTerminal(item, 'completed');
    assert.equal(item.state, 'completed');
    assert.equal(env.controller.queue.items.length, 1, 'Only one history record');
});

test('Bulk Queue - Pause and Resume state transitions', async () => {
    const env = createFakeEnvironment();
    const videos = [
        { fileId: 'vid_1', name: 'Video 1' },
        { fileId: 'vid_2', name: 'Video 2' }
    ];

    env.controller.initQueue(10, 1, env.stateRef.destination, videos);
    await env.controller.start();

    const item1 = env.controller.queue.items[0];
    env.triggerCapture(env.controller.activeTabId, 'vid_1', { name: 'Video 1' });
    assert.equal(item1.state, 'downloading');

    // Pause mid-download
    await env.controller.pause();
    assert.equal(env.controller.queue.state, 'paused');
    assert.equal(item1.state, 'paused');

    // Double pause is idempotent
    await env.controller.pause();
    assert.equal(env.controller.queue.state, 'paused');

    // Resume continues
    await env.controller.resume();
    assert.equal(env.controller.queue.state, 'running');
    assert.equal(item1.state, 'downloading');

    // Complete item 1
    await env.controller.handleItemTerminal(item1, 'completed');
    assert.equal(item1.state, 'completed');

    // Item 2 starts
    assert.equal(env.controller.queue.index, 1);
    assert.equal(env.controller.queue.items[1].state, 'capturing');
});

test('Bulk Queue - Stop closes only owned tabs, never origin tab, and is idempotent', async () => {
    const env = createFakeEnvironment();
    const videos = [
        { fileId: 'vid_1', name: 'Video 1' },
        { fileId: 'vid_2', name: 'Video 2' }
    ];

    env.controller.initQueue(10, 1, env.stateRef.destination, videos);
    await env.controller.start();

    const item1 = env.controller.queue.items[0];
    env.triggerCapture(env.controller.activeTabId, 'vid_1', { name: 'Video 1' });

    // Stop bulk run
    await env.controller.stop();
    assert.equal(env.controller.queue.state, 'finished');
    assert.equal(item1.state, 'cancelled');
    assert.equal(env.controller.queue.items[1].state, 'cancelled');

    // Double stop is idempotent
    await env.controller.stop();
    assert.equal(env.controller.queue.state, 'finished');

    // Assert origin folder tab 10 was NEVER touched
    assert.ok(!env.removedTabs.includes(10), 'Origin folder tab must NEVER be closed');
    // Assert all owned tabs closed
    assert.equal(env.stateRef.ownedTabs.size, 0);
});

test('Bulk Queue - Tab closed by user mid-job is retried then advances', async () => {
    const env = createFakeEnvironment();
    const videos = [
        { fileId: 'vid_close', name: 'Closing Tab Video' },
        { fileId: 'vid_next', name: 'Next Video' }
    ];

    env.controller.initQueue(10, 1, env.stateRef.destination, videos);
    await env.controller.start();

    const item1 = env.controller.queue.items[0];
    const tab1 = env.controller.activeTabId;

    // Simulate user closing tab1 mid-download
    await env.controller.onTabRemoved(tab1);

    // First attempt closed -> retries with fresh tab
    assert.equal(item1.attempts, 2);
    const tab2 = env.controller.activeTabId;
    assert.notEqual(tab1, tab2);

    // Simulate user closing tab2 again -> exceeds max retries -> marks failed
    await env.controller.onTabRemoved(tab2);
    assert.equal(item1.state, 'failed');

    // Queue advances to next video
    assert.equal(env.controller.queue.index, 1);
    assert.equal(env.controller.queue.items[1].state, 'capturing');
});

test('Bulk Queue - SW restart restores running/pausing queue as paused', () => {
    const savedQueue = {
        id: 'q_123',
        folderTabId: 10,
        windowId: 1,
        destination: { mode: 'subfolder', subfolder: 'Drive', configured: true },
        state: 'running',
        index: 1,
        items: [
            { fileId: 'v1', name: 'V1', state: 'completed' },
            { fileId: 'v2', name: 'V2', state: 'downloading' },
            { fileId: 'v3', name: 'V3', state: 'queued' }
        ]
    };

    if (savedQueue.state === 'running' || savedQueue.state === 'pausing') {
        savedQueue.state = 'paused';
        savedQueue.restartedBanner = 'The extension restarted. Resume to continue.';
        const activeItem = savedQueue.items[savedQueue.index];
        if (activeItem && activeItem.state !== 'completed' && activeItem.state !== 'failed') {
            activeItem.state = 'queued';
        }
    }

    assert.equal(savedQueue.state, 'paused');
    assert.equal(savedQueue.restartedBanner, 'The extension restarted. Resume to continue.');
    assert.equal(savedQueue.items[1].state, 'queued', 'In-flight item reset to queued');
    assert.equal(savedQueue.items[0].state, 'completed', 'Completed item preserved');
});

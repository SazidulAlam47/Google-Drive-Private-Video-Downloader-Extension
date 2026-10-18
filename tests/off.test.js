import test from 'node:test';
import assert from 'node:assert/strict';
import { detachAllPassiveCaptures, reconcileDebuggerTargets, registerCaptureWaiter } from '../src/capture.js';
import { state } from '../src/state.js';

test('OFF Behavior - Detaches all passive tabs and reconciles debugger targets', async (t) => {
    await t.test('detaches all passive attached tabs and cancels waiters', () => {
        const detachedList = [];

        globalThis.chrome = {
            runtime: { lastError: null },
            debugger: {
                detach: (debuggee, cb) => {
                    detachedList.push(debuggee.tabId);
                    if (cb) cb();
                },
                getTargets: (cb) => {
                    cb([
                        { tabId: 101, attached: true, url: 'https://drive.google.com/1' },
                        { tabId: 102, attached: true, url: 'https://drive.google.com/2' },
                        { tabId: 999, attached: true, url: 'https://drive.google.com/bulk' } // bulk owned
                    ]);
                }
            }
        };

        state.extensionEnabled = false;
        state.attachedTabs = new Set([101, 102]);
        state.ownedTabs = new Set([999]); // bulk tab should not be detached by OFF

        let waiterCancelled = false;
        registerCaptureWaiter(101, 'file_1', () => {}, (err) => {
            waiterCancelled = true;
        });

        detachAllPassiveCaptures();

        assert.equal(state.attachedTabs.size, 0, 'attachedTabs should be cleared');
        assert.ok(detachedList.includes(101), 'Tab 101 detached');
        assert.ok(detachedList.includes(102), 'Tab 102 detached');
        assert.ok(!detachedList.includes(999), 'Bulk owned tab 999 must NOT be detached by passive OFF');
        assert.equal(waiterCancelled, true, 'In-flight capture waiters were cancelled');
    });

    await t.test('works with no active tab or non-Drive tab', () => {
        state.extensionEnabled = false;
        state.attachedTabs = new Set();
        state.ownedTabs = new Set();

        // Should execute cleanly without error
        assert.doesNotThrow(() => {
            detachAllPassiveCaptures();
            reconcileDebuggerTargets();
        });
    });
});

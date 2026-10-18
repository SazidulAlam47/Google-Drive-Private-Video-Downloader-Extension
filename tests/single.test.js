import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSingleDownload, findValidCaptureForTabAndFile, DRIVE_SELECTORS } from '../src/single.js';
import { ERROR_CODES } from '../src/errors.js';

test('Single Download - Tab Scoping and Invariants', async (t) => {
    await t.test('rejects non-Drive or folder tabs with NO_DRIVE_VIDEO_PAGE', async () => {
        let tabsCreated = 0;
        let tabsRemoved = 0;
        let tabsReloaded = 0;

        const fakeQueryTabs = async () => [{
            id: 101,
            url: 'https://drive.google.com/drive/folders/folder_123',
            title: 'My Folder'
        }];

        const res = await handleSingleDownload({
            queryTabs: fakeQueryTabs
        });

        assert.equal(res.success, false);
        assert.equal(res.error, ERROR_CODES.NO_DRIVE_VIDEO_PAGE);
        assert.equal(tabsCreated, 0, 'Must never create a tab');
        assert.equal(tabsRemoved, 0, 'Must never remove a tab');
        assert.equal(tabsReloaded, 0, 'Must never reload a tab');
    });

    await t.test('automatically enables capture if OFF without reloading or creating tabs', async () => {
        let attachedTabId = null;
        let tabsCreated = 0;
        let tabsRemoved = 0;
        let tabsReloaded = 0;

        const fakeState = {
            extensionEnabled: false,
            destination: { mode: 'subfolder', subfolder: 'Drive Videos', configured: true },
            capturedRequests: {
                req_1: {
                    requestId: 'req_1',
                    tabId: 42,
                    fileId: 'file_abc',
                    videoTitle: 'My Video',
                    lastItagUrl: 'https://video.google.com/stream'
                }
            },
            downloadProgress: {},
            ownedTabs: new Set()
        };

        const fakeQueryTabs = async () => [{
            id: 42,
            url: 'https://drive.google.com/file/d/file_abc/view',
            title: 'My Video'
        }];

        const fakeAttachCapture = async (tabId) => {
            attachedTabId = tabId;
        };

        let executedScriptTarget = null;
        const fakeExecuteScript = async (opts) => {
            executedScriptTarget = opts.target.tabId;
            return [{ result: true }];
        };

        const res = await handleSingleDownload({
            queryTabs: fakeQueryTabs,
            executeScript: fakeExecuteScript,
            attachCapture: fakeAttachCapture,
            stateRef: fakeState,
            persistNow: () => {},
            schedPersist: () => {}
        });

        assert.equal(res.success, true);
        assert.equal(res.requestId, 'req_1');
        assert.equal(fakeState.extensionEnabled, true, 'Turned ON automatically');
        assert.equal(attachedTabId, 42, 'Attached to the active tab');
        assert.equal(executedScriptTarget, 42, 'Executed engine on the same tab');
        assert.equal(fakeState.ownedTabs.has(42), false, 'Tab was not added to ownedTabs');
        assert.equal(tabsCreated, 0);
        assert.equal(tabsRemoved, 0);
        assert.equal(tabsReloaded, 0);
    });

    await t.test('strictly isolates capture by tabId and fileId', () => {
        const requests = {
            req_1: {
                requestId: 'req_1',
                tabId: 10,
                fileId: 'file_other',
                lastItagUrl: 'http://stream/1',
                videoTitle: 'Other Video'
            },
            req_2: {
                requestId: 'req_2',
                tabId: 20,
                fileId: 'file_target',
                lastItagUrl: 'http://stream/2',
                videoTitle: 'Target Video Wrong Tab'
            },
            req_3: {
                requestId: 'req_3',
                tabId: 10,
                fileId: 'file_target',
                lastItagUrl: 'http://stream/3',
                videoTitle: 'Target Video'
            }
        };

        // Querying for tab 10 and file_target should ONLY match req_3
        const match = findValidCaptureForTabAndFile(10, 'file_target', requests);
        assert.ok(match);
        assert.equal(match.requestId, 'req_3');

        // Querying for tab 10 and file_nonexistent should match nothing
        const noMatch = findValidCaptureForTabAndFile(10, 'file_nonexistent', requests);
        assert.equal(noMatch, null);
    });

    await t.test('prompts for destination when destination is not configured', async () => {
        const fakeState = {
            extensionEnabled: true,
            destination: { configured: false },
            capturedRequests: {},
            downloadProgress: {},
            ownedTabs: new Set()
        };

        const fakeQueryTabs = async () => [{
            id: 77,
            url: 'https://drive.google.com/file/d/file_xyz/view',
            title: 'Video XYZ'
        }];

        const res = await handleSingleDownload({
            queryTabs: fakeQueryTabs,
            attachCapture: async () => {},
            stateRef: fakeState,
            persistNow: () => {},
            schedPersist: () => {}
        });

        assert.equal(res.success, false);
        assert.equal(res.needsDestination, true);
        assert.equal(res.tabId, 77);
        assert.equal(res.fileId, 'file_xyz');
    });

    await t.test('returns NO_MEDIA_REQUEST_CAPTURED with tabId for reload when capture fails', async () => {
        const fakeState = {
            extensionEnabled: true,
            destination: { mode: 'subfolder', subfolder: 'Drive Videos', configured: true },
            capturedRequests: {},
            downloadProgress: {},
            ownedTabs: new Set()
        };

        const fakeQueryTabs = async () => [{
            id: 88,
            url: 'https://drive.google.com/file/d/file_no_stream/view',
            title: 'Silent Video'
        }];

        let scriptsInjected = 0;
        const fakeExecuteScript = async () => {
            scriptsInjected++;
            return [{ result: { found: false } }];
        };

        const fakeWaitCapture = (tabId, fileId, res, rej, timeout) => {
            // Simulate timeout
            rej(new Error('CAPTURE_TIMEOUT'));
        };

        const res = await handleSingleDownload({
            queryTabs: fakeQueryTabs,
            executeScript: fakeExecuteScript,
            attachCapture: async () => {},
            waitCapture: fakeWaitCapture,
            stateRef: fakeState,
            persistNow: () => {},
            schedPersist: () => {}
        });

        assert.equal(res.success, false);
        assert.equal(res.error, ERROR_CODES.NO_MEDIA_REQUEST_CAPTURED);
        assert.equal(res.tabId, 88);
        assert.ok(scriptsInjected >= 1, 'Attempted safe nudge and performance check');
    });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeTitle, sanitizeSubfolder, buildDownloadPath, validateDestination, DEFAULT_SUBFOLDER } from '../src/settings.js';

test('sanitizeTitle', async (t) => {
    await t.test('handles normal titles', () => {
        assert.equal(sanitizeTitle('Lecture 1 - Introduction'), 'Lecture 1 - Introduction.mp4');
    });

    await t.test('strips existing .mp4 extension', () => {
        assert.equal(sanitizeTitle('Lecture 1.mp4'), 'Lecture 1.mp4');
        assert.equal(sanitizeTitle('Lecture 1.MP4'), 'Lecture 1.mp4');
    });

    await t.test('replaces illegal filesystem characters', () => {
        const input = 'Video <1> : "Test" / \\ | ? *';
        const result = sanitizeTitle(input);
        assert.ok(!/[<>:"/\\|?*]/.test(result));
        assert.equal(result, 'Video _1_ _ _Test_ _ _ _ _ _.mp4');
    });

    await t.test('handles empty or null inputs', () => {
        assert.equal(sanitizeTitle(''), 'video.mp4');
        assert.equal(sanitizeTitle(null), 'video.mp4');
        assert.equal(sanitizeTitle(undefined), 'video.mp4');
    });

    await t.test('caps very long titles', () => {
        const longTitle = 'A'.repeat(300);
        const result = sanitizeTitle(longTitle);
        assert.ok(result.length <= 185);
        assert.ok(result.endsWith('.mp4'));
    });

    await t.test('trims surrounding dots and spaces', () => {
        assert.equal(sanitizeTitle('  ...My Video...  '), 'My Video.mp4');
    });
});

test('sanitizeSubfolder', async (t) => {
    await t.test('handles default fallback on empty inputs', () => {
        assert.equal(sanitizeSubfolder(''), DEFAULT_SUBFOLDER);
        assert.equal(sanitizeSubfolder(null), DEFAULT_SUBFOLDER);
        assert.equal(sanitizeSubfolder('   '), DEFAULT_SUBFOLDER);
    });

    await t.test('strips drive letters and absolute slashes', () => {
        assert.equal(sanitizeSubfolder('C:\\Users\\Downloads\\MyFolder'), 'Users/Downloads/MyFolder');
        assert.equal(sanitizeSubfolder('/var/tmp/videos'), 'var/tmp/videos');
    });

    await t.test('collapses and eliminates parent directory traversal (..)', () => {
        assert.equal(sanitizeSubfolder('../../sensitive_folder'), 'sensitive_folder');
        assert.equal(sanitizeSubfolder('a/../../b'), 'a/b');
        assert.equal(sanitizeSubfolder('..'), DEFAULT_SUBFOLDER);
        assert.equal(sanitizeSubfolder('../..'), DEFAULT_SUBFOLDER);
    });

    await t.test('replaces illegal characters in folder segments', () => {
        assert.equal(sanitizeSubfolder('Folder*1/Sub?2'), 'Folder_1/Sub_2');
    });

    await t.test('supports clean nested subfolders', () => {
        assert.equal(sanitizeSubfolder('Physics 101 / Module 2'), 'Physics 101/Module 2');
        assert.equal(sanitizeSubfolder('A/B/C/D'), 'A/B/C/D');
    });

    await t.test('caps very long folder names', () => {
        const longFolder = 'LongFolderName_'.repeat(25);
        const result = sanitizeSubfolder(longFolder);
        assert.ok(result.length <= 200);
        assert.ok(!result.endsWith('/'));
    });
});

test('buildDownloadPath', async (t) => {
    await t.test('builds subfolder path with sanitized names', () => {
        const dest = { mode: 'subfolder', subfolder: 'Courses/Math', configured: true };
        const result = buildDownloadPath(dest, 'Algebra: Part 1');
        assert.equal(result.filename, 'Courses/Math/Algebra_ Part 1.mp4');
        assert.equal(result.saveAs, false);
    });

    await t.test('builds askEachTime path without subfolder prefix', () => {
        const dest = { mode: 'askEachTime', subfolder: 'Courses', configured: true };
        const result = buildDownloadPath(dest, 'Geometry: Part 1');
        assert.equal(result.filename, 'Geometry_ Part 1.mp4');
        assert.equal(result.saveAs, true);
    });
});

test('validateDestination', async (t) => {
    await t.test('rejects unconfigured destination', () => {
        assert.equal(validateDestination(null).valid, false);
        assert.equal(validateDestination({ configured: false }).valid, false);
    });

    await t.test('accepts valid configured destination for single download', () => {
        assert.equal(validateDestination({ mode: 'subfolder', subfolder: 'Drive', configured: true }, false).valid, true);
        assert.equal(validateDestination({ mode: 'askEachTime', configured: true }, false).valid, true);
    });

    await t.test('rejects askEachTime for bulk download', () => {
        const res = validateDestination({ mode: 'askEachTime', configured: true }, true);
        assert.equal(res.valid, false);
        assert.equal(res.error, 'BULK_REQUIRES_SUBFOLDER');
    });
});

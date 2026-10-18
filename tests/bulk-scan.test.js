import test from 'node:test';
import assert from 'node:assert/strict';
import { isVideoFile, isFolderItem, processScannedItems, VIDEO_EXTENSIONS } from '../src/bulk-scan.js';

test('Bulk Scan - Video and Folder Classification', async (t) => {
    await t.test('classifies videos by extension correctly', () => {
        assert.equal(isVideoFile('lecture1.mp4'), true);
        assert.equal(isVideoFile('presentation.MOV'), true);
        assert.equal(isVideoFile('movie.mkv'), true);
        assert.equal(isVideoFile('recording.webm'), true);
        assert.equal(isVideoFile('clip.avi'), true);
        assert.equal(isVideoFile('video.m4v'), true);
        assert.equal(isVideoFile('stream.ts'), false);
        assert.equal(isVideoFile('stream.mts'), true);
        assert.equal(isVideoFile('document.pdf'), false);
        assert.equal(isVideoFile('spreadsheet.xlsx'), false);
        assert.equal(isVideoFile('image.png'), false);
    });

    await t.test('classifies videos and folders by type hint', () => {
        assert.equal(isVideoFile('Custom Title Without Ext', 'video/mp4'), true);
        assert.equal(isVideoFile('Drive Video Item', 'Google Drive Video'), true);
        assert.equal(isFolderItem('Course Materials', 'Google Drive Folder'), true);
        assert.equal(isFolderItem('Subfolder 1', 'folder'), true);
        assert.equal(isVideoFile('Subfolder', 'folder'), false);
    });

    await t.test('deduplicates items across simulated scroll steps and produces correct report', () => {
        // Step 1 items
        const step1 = [
            { id: 'vid_1', name: 'Intro.mp4', typeHint: 'video' },
            { id: 'vid_2', name: 'Lecture 1.mp4', typeHint: '' },
            { id: 'fold_1', name: 'Assignments', typeHint: 'Google Drive Folder' },
            { id: 'doc_1', name: 'Syllabus.pdf', typeHint: '' }
        ];

        // Step 2 items (with duplicate vid_2 and fold_1 from virtual scrolling)
        const step2 = [
            { id: 'vid_2', name: 'Lecture 1.mp4', typeHint: '' },
            { id: 'fold_1', name: 'Assignments', typeHint: 'Google Drive Folder' },
            { id: 'vid_3', name: 'Lecture 2.mkv', typeHint: '' },
            { id: 'fold_2', name: 'Readings', typeHint: 'folder' }
        ];

        // Step 3 items (more items + more duplicates)
        const step3 = [
            { id: 'vid_3', name: 'Lecture 2.mkv', typeHint: '' },
            { id: 'vid_4', name: 'Bonus Q&A.mov', typeHint: '' },
            { id: 'doc_2', name: 'Notes.docx', typeHint: '' }
        ];

        const allRawItems = [...step1, ...step2, ...step3];
        assert.equal(allRawItems.length, 11);

        const report = processScannedItems(allRawItems);

        // Unique items: vid_1, vid_2, vid_3, vid_4 (4 videos), fold_1, fold_2 (2 folders), doc_1, doc_2 (2 docs)
        // Total unique = 8
        assert.equal(report.totalScanned, 8);
        assert.equal(report.videoCount, 4);
        assert.equal(report.subfoldersSkipped, 2);
        assert.equal(report.otherSkipped, 2);

        assert.equal(report.videos.length, 4);
        assert.deepEqual(report.videos.map(v => v.fileId), ['vid_1', 'vid_2', 'vid_3', 'vid_4']);
    });

    await t.test('handles empty or malformed input gracefully', () => {
        const report = processScannedItems(null);
        assert.equal(report.totalScanned, 0);
        assert.equal(report.videos.length, 0);

        const report2 = processScannedItems([null, undefined, {}, { id: '' }]);
        assert.equal(report2.totalScanned, 0);
        assert.equal(report2.videos.length, 0);
    });
});

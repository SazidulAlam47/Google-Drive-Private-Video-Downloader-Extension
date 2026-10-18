// Drive Folder Scanner and Video Classification
// Injected into the user's folder tab to discover all videos via DOM and scroll virtualization.

import { ERROR_CODES } from './errors.js';

export const FOLDER_SELECTORS = {
    // Potential scrollable containers for Drive file lists or grids
    SCROLLABLE_CONTAINERS: [
        '[role="main"]',
        '[data-target="doclist"]',
        '.drive-list-view',
        '.drive-grid-view',
        'div[jsname="o6D3Re"]',
        'div[role="feed"]',
        'c-wiz'
    ],
    // Elements representing Drive items
    ITEM_ELEMENTS: [
        '[data-id]',
        '[role="row"][data-target="row"]',
        '[role="option"][data-id]',
        'div[data-target="doc"]'
    ],
    // Attributes and selectors to extract item title/name
    NAME_ATTRS: ['aria-label', 'title', 'data-tooltip'],
    NAME_SELECTORS: [
        '[data-target="name"]',
        '.drive-item-name',
        '.KL4NAf',
        '.W35N6c'
    ]
};

export const VIDEO_EXTENSIONS = new Set([
    '.mp4', '.mov', '.mkv', '.avi', '.webm',
    '.m4v', '.wmv', '.flv', '.mpg', '.mpeg',
    '.3gp', '.mts', '.m2ts'
]);

/**
 * Pure helper: Classifies if a file is a video based on type hint or extension.
 */
export function isVideoFile(name, typeHint = '') {
    const hint = (typeHint || '').toLowerCase();
    if (hint.includes('video') || hint.includes('movie')) return true;
    if (hint.includes('folder') || hint.includes('directory')) return false;

    if (!name || typeof name !== 'string') return false;

    const dotIdx = name.lastIndexOf('.');
    if (dotIdx === -1) return false;

    const ext = name.substring(dotIdx).toLowerCase().trim();
    return VIDEO_EXTENSIONS.has(ext);
}

/**
 * Pure helper: Classifies if an item is a subfolder.
 */
export function isFolderItem(name, typeHint = '') {
    const hint = (typeHint || '').toLowerCase();
    if (hint.includes('folder') || hint.includes('directory')) return true;
    // Drive often puts "Google Drive Folder" in aria-label
    const n = (name || '').toLowerCase();
    if (n.includes('folder') && !n.includes('.')) return true;
    return false;
}

/**
 * Pure helper: Deduplicates and classifies scanned raw items.
 */
export function processScannedItems(rawItems) {
    if (!Array.isArray(rawItems)) {
        return {
            videos: [],
            totalScanned: 0,
            videoCount: 0,
            subfoldersSkipped: 0,
            otherSkipped: 0
        };
    }

    const seenIds = new Set();
    const uniqueItems = [];

    for (const item of rawItems) {
        if (!item || !item.id) continue;
        if (seenIds.has(item.id)) continue;
        seenIds.add(item.id);
        uniqueItems.push(item);
    }

    const videos = [];
    let subfoldersSkipped = 0;
    let otherSkipped = 0;

    for (const item of uniqueItems) {
        if (isFolderItem(item.name, item.typeHint)) {
            subfoldersSkipped++;
        } else if (isVideoFile(item.name, item.typeHint)) {
            videos.push({
                fileId: item.id,
                name: item.name || 'Untitled Video',
                typeHint: item.typeHint || ''
            });
        } else {
            otherSkipped++;
        }
    }

    return {
        videos,
        totalScanned: uniqueItems.length,
        videoCount: videos.length,
        subfoldersSkipped,
        otherSkipped
    };
}

/**
 * Self-contained in-tab scanning function injected into the user's folder tab.
 * Reads DOM items, scrolls through virtualization, and restores scroll position.
 */
export async function folderScanInTabFn(selectors) {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // Find scrollable container
    let container = null;
    const candidates = selectors.SCROLLABLE_CONTAINERS || [];
    for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (el && el.scrollHeight > el.clientHeight && el.clientHeight > 100) {
            container = el;
            break;
        }
    }

    if (!container) {
        // Fallback: look for any overflow auto/scroll container
        const allDivs = document.querySelectorAll('div');
        for (const div of allDivs) {
            if (div.scrollHeight > div.clientHeight && div.clientHeight > 200) {
                const style = window.getComputedStyle(div);
                if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
                    container = div;
                    break;
                }
            }
        }
    }

    if (!container) {
        container = document.scrollingElement || document.documentElement || document.body;
    }

    const initialScrollTop = container.scrollTop;
    const collectedMap = new Map();

    const readItems = () => {
        let els = [];
        const itemSelectors = selectors.ITEM_ELEMENTS || ['[data-id]'];
        for (const s of itemSelectors) {
            const found = container.querySelectorAll(s);
            if (found && found.length > 0) {
                els = Array.from(found);
                break;
            }
        }

        if (els.length === 0) {
            els = Array.from(container.querySelectorAll('[data-id]'));
        }

        for (const el of els) {
            let id = el.getAttribute('data-id');
            if (!id && el.getAttribute('data-target') === 'row') {
                const idEl = el.querySelector('[data-id]');
                if (idEl) id = idEl.getAttribute('data-id');
            }

            if (!id) {
                const link = el.querySelector('a[href*="/file/d/"], a[href*="/drive/folders/"]');
                if (link && link.href) {
                    const m = link.href.match(/\/(?:file\/d|folders)\/([a-zA-Z0-9_-]+)/);
                    if (m) id = m[1];
                }
            }

            if (!id) continue;

            // Extract item name
            let name = '';
            for (const attr of (selectors.NAME_ATTRS || ['aria-label', 'title'])) {
                const val = el.getAttribute(attr);
                if (val && val.trim()) {
                    name = val.trim();
                    break;
                }
            }

            if (!name) {
                for (const nameSel of (selectors.NAME_SELECTORS || [])) {
                    const nameEl = el.querySelector(nameSel);
                    if (nameEl && nameEl.textContent && nameEl.textContent.trim()) {
                        name = nameEl.textContent.trim();
                        break;
                    }
                }
            }

            if (!name) {
                name = (el.innerText || el.textContent || '').split('\n')[0].trim();
            }

            // Extract type hint
            let typeHint = '';
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            if (aria.includes('folder') || aria.includes('directory')) {
                typeHint = 'folder';
            } else if (aria.includes('video') || aria.includes('movie')) {
                typeHint = 'video';
            }

            if (!collectedMap.has(id)) {
                collectedMap.set(id, { id, name, typeHint });
            }
        }
    };

    // Initial read
    readItems();

    // Scroll loop
    const MAX_STEPS = 50;
    const MAX_TIME_MS = 30000;
    const startTime = Date.now();
    let stepsWithoutNew = 0;
    let stepCount = 0;

    while (stepCount < MAX_STEPS && (Date.now() - startTime) < MAX_TIME_MS) {
        const countBefore = collectedMap.size;
        const scrollDelta = Math.max(200, Math.floor(container.clientHeight * 0.8));

        container.scrollTop += scrollDelta;
        await sleep(350);

        readItems();
        stepCount++;

        const isAtBottom = (container.scrollTop + container.clientHeight >= container.scrollHeight - 15);
        if (collectedMap.size === countBefore) {
            stepsWithoutNew++;
            if (stepsWithoutNew >= 4 && isAtBottom) {
                break;
            }
        } else {
            stepsWithoutNew = 0;
        }

        if (isAtBottom && stepsWithoutNew >= 2) {
            break;
        }
    }

    // Restore original scroll position
    container.scrollTop = initialScrollTop;

    return Array.from(collectedMap.values());
}

/**
 * Controller function to scan a Drive folder tab
 */
export async function executeFolderScan(tabId, {
    executeScript = (opts) => chrome.scripting.executeScript(opts)
} = {}) {
    try {
        const results = await executeScript({
            target: { tabId: tabId },
            func: folderScanInTabFn,
            args: [FOLDER_SELECTORS]
        });

        const rawItems = results && results[0] && results[0].result;
        return processScannedItems(rawItems || []);
    } catch (err) {
        throw new Error('FOLDER_SCAN_FAILED: ' + (err && err.message ? err.message : String(err)));
    }
}

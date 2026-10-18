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

// Known video file extensions (lowercase). Note: .ts is deliberately omitted due to ambiguity with TypeScript.
export const VIDEO_EXTENSIONS = new Set([
    '.mp4', '.mov', '.mkv', '.avi', '.webm',
    '.m4v', '.wmv', '.flv', '.mpg', '.mpeg',
    '.3gp', '.mts', '.m2ts',
    '.ogv', '.vob', '.mxf', '.divx', '.asf',
    '.rm', '.rmvb', '.f4v', '.m2v', '.qt'
]);

/**
 * Extracts a matching video extension from a filename.
 * Handles trailing descriptors such as "video.mp4 (1)" or "video.mkv copy".
 * Case-insensitive and strips trailing whitespace.
 */
export function extractVideoExtension(rawName) {
    if (!rawName || typeof rawName !== 'string') return null;
    const name = rawName.trim();

    // 1. Direct extension at the end
    const lastDot = name.lastIndexOf('.');
    if (lastDot !== -1) {
        const directExt = name.slice(lastDot).toLowerCase().trim();
        if (VIDEO_EXTENSIONS.has(directExt)) {
            return directExt;
        }
    }

    // 2. Extension before a trailing descriptor (e.g. "video.mp4 (1)", "video.mp4 copy", "video.mp4_1")
    const match = name.match(/\.([a-zA-Z0-9]{2,5})(?:[\s(_\-[].*)?$/);
    if (match) {
        const candExt = '.' + match[1].toLowerCase();
        if (VIDEO_EXTENSIONS.has(candExt)) {
            return candExt;
        }
    }

    return null;
}

/**
 * Pure helper: Classifies if an item is a subfolder based ONLY on type signals.
 * Never treats a file as a folder based on its file name alone.
 */
export function isFolderItem(name, typeHint = '', signals = [], href = '', ariaLabelRaw = '') {
    // 1. Check href
    if (href && (href.includes('/drive/folders/') || href.includes('/folders/'))) {
        return { isFolder: true, matchedSignal: 'href: /drive/folders/' };
    }

    // 2. Check type hint
    const hint = (typeHint || '').toLowerCase();
    if (hint === 'folder' || hint === 'directory') {
        return { isFolder: true, matchedSignal: `typeHint: ${typeHint}` };
    }

    // 3. Check type signals
    const folderWordRegex = /\b(?:folder|directory)\b/i;
    for (const sig of (signals || [])) {
        if (sig && folderWordRegex.test(sig)) {
            return { isFolder: true, matchedSignal: `signal: ${sig}` };
        }
    }

    // 4. Check ariaRemainder (ariaLabelRaw with name stripped)
    if (ariaLabelRaw && name) {
        const ariaRemainder = ariaLabelRaw.replace(name, '').trim();
        if (ariaRemainder && folderWordRegex.test(ariaRemainder)) {
            return { isFolder: true, matchedSignal: `ariaRemainder: ${ariaRemainder}` };
        }
    }

    return { isFolder: false, matchedSignal: 'none' };
}

/**
 * Pure helper: Classifies if an item is a video based on extension, type hint, or descendant signals.
 */
export function isVideoItem(name, typeHint = '', signals = [], ariaLabelRaw = '') {
    // 1. Check extension
    const ext = extractVideoExtension(name);
    if (ext) {
        return { isVideo: true, matchedSignal: `extension: ${ext}` };
    }

    // 2. Check type hint
    const hint = (typeHint || '').toLowerCase();
    if (hint === 'video' || hint === 'movie') {
        return { isVideo: true, matchedSignal: `typeHint: ${typeHint}` };
    }

    // 3. Descendant signals (excluding file name)
    const videoWordRegex = /\b(?:video|movie)\b/i;
    const videoMimeRegex = /\bvideo\/(?:mp4|webm|ogg|x-matroska|quicktime|x-msvideo|mpeg)/i;

    for (const sig of (signals || [])) {
        if (!sig) continue;
        if (videoWordRegex.test(sig) || videoMimeRegex.test(sig)) {
            return { isVideo: true, matchedSignal: `signal: ${sig}` };
        }
    }

    // 4. ariaRemainder (ariaLabelRaw with name stripped)
    if (ariaLabelRaw && name) {
        const ariaRemainder = ariaLabelRaw.replace(name, '').trim();
        if (ariaRemainder && (videoWordRegex.test(ariaRemainder) || videoMimeRegex.test(ariaRemainder))) {
            return { isVideo: true, matchedSignal: `ariaRemainder: ${ariaRemainder}` };
        }
    }

    return { isVideo: false, matchedSignal: 'none' };
}

export function isVideoFile(name, typeHint = '', signals = [], ariaLabelRaw = '') {
    return isVideoItem(name, typeHint, signals, ariaLabelRaw).isVideo;
}

/**
 * Pure helper: Classifies an item into 'folder' | 'video' | 'other' with reasons.
 */
export function classifyScannedItem(item) {
    const name = item.name || '';
    const typeHint = item.typeHint || '';
    const signals = item.signals || [];
    const href = item.href || '';
    const ariaLabelRaw = item.ariaLabelRaw || '';

    // Step 1: Check folder
    const folderRes = isFolderItem(name, typeHint, signals, href, ariaLabelRaw);
    if (folderRes.isFolder) {
        return {
            classification: 'folder',
            isVideo: false,
            isFolder: true,
            reason: 'folder type signal',
            matchedSignal: folderRes.matchedSignal
        };
    }

    // Step 2: Check video
    const videoRes = isVideoItem(name, typeHint, signals, ariaLabelRaw);
    if (videoRes.isVideo) {
        return {
            classification: 'video',
            isVideo: true,
            isFolder: false,
            reason: 'video type signal',
            matchedSignal: videoRes.matchedSignal
        };
    }

    // Step 3: Unrecognized (other)
    let reason = 'no recognized video extension or signals';
    const lastDot = name.lastIndexOf('.');
    if (lastDot !== -1 && lastDot < name.length - 1) {
        const candExt = name.slice(lastDot).toLowerCase().trim();
        if (candExt.length <= 6 && !candExt.includes(' ')) {
            reason = `non-video extension (${candExt})`;
        }
    }

    if (reason === 'no recognized video extension or signals') {
        const allText = `${typeHint} ${(signals || []).join(' ')} ${ariaLabelRaw}`.toLowerCase();
        if (/\b(?:pdf)\b/i.test(allText)) {
            reason = 'pdf document';
        } else if (/\b(?:document|docs?|word|text)\b/i.test(allText)) {
            reason = 'document';
        } else if (/\b(?:spreadsheet|sheets?|excel)\b/i.test(allText)) {
            reason = 'spreadsheet';
        } else if (/\b(?:presentation|slides?|powerpoint)\b/i.test(allText)) {
            reason = 'presentation';
        } else if (/\b(?:image|photo|picture)\b/i.test(allText)) {
            reason = 'image';
        } else if (/\b(?:audio|sound|music)\b/i.test(allText)) {
            reason = 'audio';
        } else if (/\b(?:archive|zip|tar|rar)\b/i.test(allText)) {
            reason = 'archive';
        }
    }

    return {
        classification: 'other',
        isVideo: false,
        isFolder: false,
        reason,
        matchedSignal: 'none'
    };
}

/**
 * Pure helper: Deduplicates and classifies scanned raw items into videos and others buckets.
 */
export function processScannedItems(rawResult) {
    let rawItems = [];
    let stats = null;

    if (rawResult && Array.isArray(rawResult.items)) {
        rawItems = rawResult.items;
        stats = rawResult.stats || null;
    } else if (Array.isArray(rawResult)) {
        rawItems = rawResult;
    }

    const seenIds = new Set();
    const uniqueItems = [];

    for (const item of rawItems) {
        if (!item) continue;
        const id = item.id || item.fileId;
        if (!id) continue;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        uniqueItems.push({
            ...item,
            id
        });
    }

    const videos = [];
    const others = [];
    let subfoldersSkipped = 0;

    for (const item of uniqueItems) {
        const res = classifyScannedItem(item);
        item.classification = res.classification;
        item.reason = res.reason;
        item.matchedSignal = res.matchedSignal;

        if (res.isFolder) {
            subfoldersSkipped++;
        } else if (res.isVideo) {
            videos.push({
                fileId: item.id,
                name: item.name || 'Untitled Video',
                typeHint: item.typeHint || '',
                reason: res.reason,
                matchedSignal: res.matchedSignal
            });
        } else {
            others.push({
                fileId: item.id,
                name: item.name || 'Untitled File',
                typeHint: item.typeHint || '',
                reason: res.reason,
                matchedSignal: res.matchedSignal,
                unverifiedType: true
            });
        }
    }

    return {
        videos,
        others,
        totalScanned: uniqueItems.length,
        videoCount: videos.length,
        otherCount: others.length,
        subfoldersSkipped,
        otherSkipped: others.length,
        stats,
        diagnostics: {
            stats: stats || {},
            items: uniqueItems.map(i => ({
                id: i.id,
                name: i.name || '',
                role: i.role || '',
                tagName: i.tagName || '',
                innerText: i.innerText || '',
                signals: i.signals || [],
                matchedSignal: i.matchedSignal || 'none',
                classification: i.classification || 'other',
                reason: i.reason || ''
            }))
        }
    };
}

/**
 * Self-contained in-tab scanning function injected into the user's folder tab.
 * Reads DOM items, scrolls through virtualization, and restores scroll position.
 */
export async function folderScanInTabFn(selectors) {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // 1. Find candidate scrollable container and verify it actually scrolls
    const candidates = [];
    const selectorList = (selectors && selectors.SCROLLABLE_CONTAINERS) || [];

    for (const sel of selectorList) {
        try {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
                if (el && el.nodeType === 1) {
                    candidates.push({ el, name: sel });
                }
            }
        } catch (e) {}
    }

    // Also look for scrollable divs with overflow auto/scroll
    try {
        const allDivs = document.querySelectorAll('div');
        for (const div of allDivs) {
            if (div.scrollHeight > div.clientHeight + 40 && div.clientHeight > 150) {
                const style = window.getComputedStyle(div);
                if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
                    candidates.push({ el: div, name: `div.${(div.className || '').toString().slice(0, 30)}` });
                }
            }
        }
    } catch (e) {}

    const docScroller = document.scrollingElement || document.documentElement || document.body;
    if (docScroller) {
        candidates.push({ el: docScroller, name: 'document.scrollingElement' });
    }

    let chosen = null;
    let maxItemCount = -1;

    for (const cand of candidates) {
        const el = cand.el;
        if (!el) continue;
        const itemCount = el.querySelectorAll('[data-id]').length;
        const canScroll = (el.scrollHeight > el.clientHeight + 10);

        if (itemCount > maxItemCount && (canScroll || itemCount > 0)) {
            // Verify container actually moves
            const orig = el.scrollTop;
            el.scrollTop = orig + 10;
            const didMove = (el.scrollTop !== orig);
            el.scrollTop = orig; // restore test scroll

            if (didMove || el === docScroller) {
                chosen = { el, name: cand.name, itemCount, didMove };
                maxItemCount = itemCount;
            }
        }
    }

    if (!chosen) {
        chosen = { el: docScroller, name: 'fallback (document.scrollingElement)' };
    }

    const container = chosen.el;
    const initialScrollTop = container.scrollTop;
    const startedAtScrollTop = initialScrollTop;

    // 2. Always scroll to top first and wait for DOM to settle
    container.scrollTop = 0;
    if (document.scrollingElement && document.scrollingElement !== container) {
        document.scrollingElement.scrollTop = 0;
    }
    window.scrollTo(0, 0);

    const settleStart = Date.now();
    let lastItemCount = -1;
    let stableChecks = 0;

    while (Date.now() - settleStart < 3000) {
        await sleep(250);
        const count = container.querySelectorAll('[data-id]').length;
        if (count === lastItemCount && count > 0) {
            stableChecks++;
            if (stableChecks >= 2) break;
        } else {
            lastItemCount = count;
            stableChecks = 0;
        }
    }
    const topSettleMs = Date.now() - settleStart;

    const collectedMap = new Map();

    const readItems = () => {
        let els = [];
        const itemSelectors = (selectors && selectors.ITEM_ELEMENTS) || ['[data-id]'];
        for (const s of itemSelectors) {
            try {
                const found = container.querySelectorAll(s);
                if (found && found.length > 0) {
                    els = Array.from(found);
                    break;
                }
            } catch (e) {}
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

            let href = '';
            const link = el.querySelector('a[href*="/file/d/"], a[href*="/drive/folders/"], a[href*="/folders/"]');
            if (link && link.href) {
                href = link.href;
                if (!id) {
                    const m = link.href.match(/\/(?:file\/d|folders)\/([a-zA-Z0-9_-]+)/);
                    if (m) id = m[1];
                }
            }

            if (!id) continue;

            // Extract item name
            let name = '';
            for (const attr of ((selectors && selectors.NAME_ATTRS) || ['aria-label', 'title'])) {
                const val = el.getAttribute(attr);
                if (val && val.trim()) {
                    name = val.trim();
                    break;
                }
            }

            if (!name) {
                for (const nameSel of ((selectors && selectors.NAME_SELECTORS) || [])) {
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

            const ariaLabelRaw = el.getAttribute('aria-label') || '';
            const role = el.getAttribute('role') || '';
            const tagName = el.tagName ? el.tagName.toLowerCase() : '';
            const innerText = (el.innerText || el.textContent || '').slice(0, 120).trim();

            // Collect compact signals
            const rawSignals = [];

            // Descendant img[alt]
            const imgs = el.querySelectorAll('img[alt]');
            for (const img of imgs) {
                const alt = (img.getAttribute('alt') || '').trim();
                if (alt && alt !== name) rawSignals.push(alt);
            }

            // Descendant svg titles or aria-labels
            const svgs = el.querySelectorAll('svg');
            for (const svg of svgs) {
                const aria = (svg.getAttribute('aria-label') || '').trim();
                if (aria && aria !== name) rawSignals.push(aria);
                const titleEl = svg.querySelector('title');
                if (titleEl && titleEl.textContent && titleEl.textContent.trim() !== name) {
                    rawSignals.push(titleEl.textContent.trim());
                }
            }

            // Descendant named elements
            const namedDescendants = el.querySelectorAll('[aria-label], [title], [data-tooltip]');
            for (const d of namedDescendants) {
                if (d === el) continue;
                const al = (d.getAttribute('aria-label') || '').trim();
                if (al && al !== name && al.length < 100) rawSignals.push(al);
                const ti = (d.getAttribute('title') || '').trim();
                if (ti && ti !== name && ti.length < 100) rawSignals.push(ti);
                const dt = (d.getAttribute('data-tooltip') || '').trim();
                if (dt && dt !== name && dt.length < 100) rawSignals.push(dt);
            }

            // Attributes with mime, type, kind, video
            const checkAttrs = (targetEl) => {
                if (!targetEl || !targetEl.attributes) return;
                for (let i = 0; i < targetEl.attributes.length; i++) {
                    const attr = targetEl.attributes[i];
                    const aName = attr.name.toLowerCase();
                    const aVal = (attr.value || '').trim();
                    if (aName.includes('mime') || aName.includes('type') || aName.includes('kind') || aName.includes('video')) {
                        if (aVal && aVal !== name) {
                            rawSignals.push(`${aName}=${aVal.slice(0, 50)}`);
                        }
                    }
                }
            };
            checkAttrs(el);
            const typedDescendants = el.querySelectorAll('[data-mime-type], [data-type], [data-kind], [type]');
            for (const d of typedDescendants) {
                checkAttrs(d);
            }

            // Deduplicate and cap to 12 signals
            const seenSig = new Set();
            const signals = [];
            for (const s of rawSignals) {
                const clean = s.slice(0, 80).trim();
                if (clean && !seenSig.has(clean)) {
                    seenSig.add(clean);
                    signals.push(clean);
                    if (signals.length >= 12) break;
                }
            }

            let typeHint = '';
            if (signals.some(s => /\b(?:video|movie)\b/i.test(s) || /video\//i.test(s))) {
                typeHint = 'video';
            } else if (signals.some(s => /\b(?:folder|directory)\b/i.test(s))) {
                typeHint = 'folder';
            }

            if (!collectedMap.has(id)) {
                collectedMap.set(id, {
                    id,
                    name,
                    typeHint,
                    ariaLabelRaw,
                    role,
                    tagName,
                    innerText,
                    signals,
                    href
                });
            }
        }
    };

    const startTime = Date.now();
    let stepCount = 0;
    let stoppedBy = 'bottom';

    try {
        // Initial read
        readItems();

        // Adaptive scroll loop
        const MAX_STEPS = 400;
        const MAX_TIME_MS = 120000;
        let stepsWithoutNew = 0;

        while (stepCount < MAX_STEPS && (Date.now() - startTime) < MAX_TIME_MS) {
            const countBefore = collectedMap.size;
            const scrollDelta = Math.max(200, Math.floor(container.clientHeight * 0.8));

            container.scrollTop += scrollDelta;
            await sleep(300);

            readItems();
            stepCount++;

            const isAtBottom = (container.scrollTop + container.clientHeight >= container.scrollHeight - 15);
            if (collectedMap.size === countBefore) {
                stepsWithoutNew++;
                if (isAtBottom && stepsWithoutNew >= 4) {
                    stoppedBy = 'bottom';
                    break;
                }
            } else {
                stepsWithoutNew = 0;
            }
        }

        if (stepCount >= MAX_STEPS) {
            stoppedBy = 'maxSteps';
        } else if ((Date.now() - startTime) >= MAX_TIME_MS) {
            stoppedBy = 'maxTime';
        }
    } finally {
        // ALWAYS restore user's original scroll position
        container.scrollTop = initialScrollTop;
        if (container === document.scrollingElement || container === document.documentElement || container === document.body) {
            window.scrollTo(0, initialScrollTop);
        }
    }

    const stats = {
        containerFound: `${chosen.name} (scrollHeight=${container.scrollHeight}, clientHeight=${container.clientHeight})`,
        stoppedBy,
        steps: stepCount,
        elapsedMs: Date.now() - startTime,
        itemCount: collectedMap.size,
        startedAtScrollTop,
        scrolledToTop: true,
        topSettleMs
    };

    return {
        items: Array.from(collectedMap.values()),
        stats
    };
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

        const rawResult = results && results[0] && results[0].result;
        return processScannedItems(rawResult || []);
    } catch (err) {
        throw new Error('FOLDER_SCAN_FAILED: ' + (err && err.message ? err.message : String(err)));
    }
}

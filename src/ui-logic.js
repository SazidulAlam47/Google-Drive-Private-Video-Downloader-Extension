// Pure UI logic and state derivations for Side Panel and Bulk Queue

export function getBulkControlsState(queue) {
    if (!queue || queue.state === 'idle') {
        return {
            showPanel: false,
            badgeText: '',
            badgeClass: 'bulk-status-badge',
            pause: { label: '⏸ Pause', enabled: false, visible: false },
            stop: { enabled: false, visible: false },
            dismissVisible: false,
            showCurrentItem: false,
            summaryText: ''
        };
    }

    const state = queue.state || 'running';
    const total = Array.isArray(queue.items) ? queue.items.length : 0;
    const completed = Array.isArray(queue.items) ? queue.items.filter(i => i.state === 'completed').length : 0;
    const failed = Array.isArray(queue.items) ? queue.items.filter(i => i.state === 'failed').length : 0;
    const summaryText = `${completed} / ${total} · ${failed} failed`;

    const activeItem = queue.items && typeof queue.index === 'number' ? queue.items[queue.index] : null;

    if (state === 'running') {
        return {
            showPanel: true,
            badgeText: 'running',
            badgeClass: 'bulk-status-badge running',
            pause: { label: '⏸ Pause', enabled: true, visible: true },
            stop: { enabled: true, visible: true },
            dismissVisible: false,
            showCurrentItem: Boolean(activeItem),
            summaryText
        };
    }

    if (state === 'pausing') {
        return {
            showPanel: true,
            badgeText: 'pausing',
            badgeClass: 'bulk-status-badge paused',
            pause: { label: 'Pausing...', enabled: false, visible: true },
            stop: { enabled: true, visible: true },
            dismissVisible: false,
            showCurrentItem: Boolean(activeItem),
            summaryText
        };
    }

    if (state === 'paused') {
        return {
            showPanel: true,
            badgeText: 'paused',
            badgeClass: 'bulk-status-badge paused',
            pause: { label: '▶ Resume', enabled: true, visible: true },
            stop: { enabled: true, visible: true },
            dismissVisible: false,
            showCurrentItem: Boolean(activeItem),
            summaryText
        };
    }

    if (state === 'stopping') {
        return {
            showPanel: true,
            badgeText: 'stopping',
            badgeClass: 'bulk-status-badge stopped',
            pause: { label: '⏸ Pause', enabled: false, visible: true },
            stop: { enabled: false, visible: true },
            dismissVisible: false,
            showCurrentItem: false,
            summaryText
        };
    }

    if (state === 'finished') {
        return {
            showPanel: true,
            badgeText: 'finished',
            badgeClass: 'bulk-status-badge finished',
            pause: { label: '⏸ Pause', enabled: false, visible: false },
            stop: { enabled: false, visible: false },
            dismissVisible: true,
            showCurrentItem: false,
            summaryText
        };
    }

    if (state === 'stopped') {
        return {
            showPanel: true,
            badgeText: 'stopped',
            badgeClass: 'bulk-status-badge stopped',
            pause: { label: '⏸ Pause', enabled: false, visible: false },
            stop: { enabled: false, visible: false },
            dismissVisible: true,
            showCurrentItem: false,
            summaryText
        };
    }

    // Fallback for any unknown state
    return {
        showPanel: true,
        badgeText: state,
        badgeClass: `bulk-status-badge ${state}`,
        pause: { label: '⏸ Pause', enabled: false, visible: false },
        stop: { enabled: false, visible: false },
        dismissVisible: true,
        showCurrentItem: false,
        summaryText
    };
}

/**
 * Computes selection UI state and derived values.
 * @param {Array} videos - Array of video entries from folder scan.
 * @param {Set|Array} selectedIdsSet - Set or Array of currently selected fileIds.
 * @returns {Object} { total, selected, allSelected, noneSelected, selectAllEnabled, deselectAllEnabled, startEnabled, startLabel, summaryText }
 */
export function computeSelectionState(videos, selectedIdsSet) {
    const list = Array.isArray(videos) ? videos : [];
    const total = list.length;
    const set = selectedIdsSet instanceof Set
        ? selectedIdsSet
        : new Set(Array.isArray(selectedIdsSet) ? selectedIdsSet : []);

    let selected = 0;
    for (const v of list) {
        if (v && v.fileId && set.has(v.fileId)) {
            selected++;
        }
    }

    const allSelected = total > 0 && selected === total;
    const noneSelected = selected === 0;
    const selectAllEnabled = total > 0 && selected < total;
    const deselectAllEnabled = selected > 0;
    const startEnabled = selected > 0;
    const startLabel = `Start Download (${selected})`;
    const summaryText = `Found ${total} ${total === 1 ? 'video' : 'videos'} · ${selected} selected`;

    return {
        total,
        selected,
        allSelected,
        noneSelected,
        selectAllEnabled,
        deselectAllEnabled,
        startEnabled,
        startLabel,
        summaryText
    };
}

/**
 * Filters and orders scan videos based on user selection, de-duplicating and dropping unknown IDs.
 * Preserves the original scan order.
 * @param {Array} scanVideos - Array of video objects from folder scan ({ fileId, name, ... }).
 * @param {Array|Set} selectedIds - Iterable/Array/Set of selected fileIds.
 * @returns {Array} Ordered, de-duplicated array of chosen scan entries.
 */
export function filterSelectedVideos(scanVideos, selectedIds) {
    if (!Array.isArray(scanVideos) || !selectedIds) {
        return [];
    }

    const selectedSet = selectedIds instanceof Set
        ? selectedIds
        : new Set(Array.isArray(selectedIds) ? selectedIds : []);

    if (selectedSet.size === 0) {
        return [];
    }

    const seen = new Set();
    const result = [];

    for (const item of scanVideos) {
        if (!item || !item.fileId) continue;
        if (selectedSet.has(item.fileId) && !seen.has(item.fileId)) {
            seen.add(item.fileId);
            result.push(item);
        }
    }

    return result;
}

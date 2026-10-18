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
 * Computes selection UI state and derived values across videos and other unverified files.
 * @param {Array} videos - Array of recognized video entries from folder scan.
 * @param {Array|Set} othersOrSelectedIds - Array of other file entries, or selectedIdsSet if others omitted.
 * @param {Set|Array} [maybeSelectedIds] - Set or Array of currently selected fileIds when others is provided.
 * @returns {Object} Selection state and controls enablement.
 */
export function computeSelectionState(videos, othersOrSelectedIds, maybeSelectedIds) {
    let videoList = [];
    let otherList = [];
    let selectedIdsSet = null;

    if (maybeSelectedIds !== undefined) {
        videoList = Array.isArray(videos) ? videos : [];
        otherList = Array.isArray(othersOrSelectedIds) ? othersOrSelectedIds : [];
        selectedIdsSet = maybeSelectedIds;
    } else if (othersOrSelectedIds instanceof Set || Array.isArray(othersOrSelectedIds)) {
        videoList = Array.isArray(videos) ? videos : [];
        otherList = [];
        selectedIdsSet = othersOrSelectedIds;
    } else {
        videoList = Array.isArray(videos) ? videos : [];
        otherList = [];
        selectedIdsSet = new Set();
    }

    const totalVideos = videoList.length;
    const totalOthers = otherList.length;
    const total = totalVideos + totalOthers;

    const set = selectedIdsSet instanceof Set
        ? selectedIdsSet
        : new Set(Array.isArray(selectedIdsSet) ? selectedIdsSet : []);

    let selectedVideos = 0;
    for (const v of videoList) {
        if (v && v.fileId && set.has(v.fileId)) {
            selectedVideos++;
        }
    }

    let selectedOthers = 0;
    for (const o of otherList) {
        if (o && o.fileId && set.has(o.fileId)) {
            selectedOthers++;
        }
    }

    const selected = selectedVideos + selectedOthers;

    const allVideosSelected = totalVideos > 0 && selectedVideos === totalVideos;
    const noVideosSelected = selectedVideos === 0;
    const selectAllEnabled = totalVideos > 0 && selectedVideos < totalVideos;
    const deselectAllEnabled = selectedVideos > 0;

    const allOthersSelected = totalOthers > 0 && selectedOthers === totalOthers;
    const noOthersSelected = selectedOthers === 0;
    const includeAllOthersEnabled = totalOthers > 0 && selectedOthers < totalOthers;
    const excludeAllOthersEnabled = selectedOthers > 0;

    const startEnabled = selected > 0;
    const startLabel = `Start Download (${selected})`;

    let summaryText = '';
    if (totalOthers > 0) {
        summaryText = `Found ${totalVideos} video${totalVideos === 1 ? '' : 's'} (+${totalOthers} other file${totalOthers === 1 ? '' : 's'}) · ${selected} selected`;
    } else {
        summaryText = `Found ${totalVideos} video${totalVideos === 1 ? '' : 's'} · ${selected} selected`;
    }

    return {
        total,
        totalVideos,
        totalOthers,
        selected,
        selectedVideos,
        selectedOthers,
        allSelected: total > 0 && selected === total,
        noneSelected: selected === 0,
        allVideosSelected,
        noVideosSelected,
        selectAllEnabled,
        deselectAllEnabled,
        allOthersSelected,
        noOthersSelected,
        includeAllOthersEnabled,
        excludeAllOthersEnabled,
        startEnabled,
        startLabel,
        summaryText
    };
}

/**
 * Filters and orders scan videos based on user selection, de-duplicating and dropping unknown IDs.
 * Preserves scan order (videos first in scan order, then others in scan order).
 * Items originating from the 'others' bucket are tagged with `unverifiedType: true`.
 * @param {Array|Object} videosInput - Array of video objects or { videos, others } container object.
 * @param {Array|Set} othersOrSelectedIds - Array of other files, or selectedIds if 2-arg signature.
 * @param {Array|Set} [maybeSelectedIds] - Iterable/Array/Set of selected fileIds when 3-arg signature.
 * @returns {Array} Ordered, de-duplicated array of chosen scan entries.
 */
export function filterSelectedVideos(videosInput, othersOrSelectedIds, maybeSelectedIds) {
    let videoList = [];
    let otherList = [];
    let selectedIds = null;

    if (maybeSelectedIds !== undefined) {
        videoList = Array.isArray(videosInput) ? videosInput : [];
        otherList = Array.isArray(othersOrSelectedIds) ? othersOrSelectedIds : [];
        selectedIds = maybeSelectedIds;
    } else if (videosInput && typeof videosInput === 'object' && !Array.isArray(videosInput) && (videosInput.videos || videosInput.others)) {
        videoList = Array.isArray(videosInput.videos) ? videosInput.videos : [];
        otherList = Array.isArray(videosInput.others) ? videosInput.others : [];
        selectedIds = othersOrSelectedIds;
    } else {
        videoList = Array.isArray(videosInput) ? videosInput : [];
        otherList = [];
        selectedIds = othersOrSelectedIds;
    }

    if (!selectedIds) {
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
    const otherIdSet = new Set(otherList.map(o => o.fileId));

    const combined = [];
    for (const v of videoList) {
        if (v && v.fileId) combined.push(v);
    }
    for (const o of otherList) {
        if (o && o.fileId) {
            combined.push({ ...o, unverifiedType: true });
        }
    }

    for (const item of combined) {
        if (!item || !item.fileId) continue;
        if (selectedSet.has(item.fileId) && !seen.has(item.fileId)) {
            seen.add(item.fileId);
            const isUnverified = Boolean(item.unverifiedType || otherIdSet.has(item.fileId));
            result.push({
                ...item,
                unverifiedType: isUnverified
            });
        }
    }

    return result;
}

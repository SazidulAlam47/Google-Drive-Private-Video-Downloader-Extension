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

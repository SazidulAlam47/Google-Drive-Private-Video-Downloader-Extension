// Side Panel Controller
import { ERROR_CODES, getErrorMessage } from './src/errors.js';
import { getBulkControlsState, computeSelectionState, filterSelectedVideos } from './src/ui-logic.js';

document.addEventListener("DOMContentLoaded", () => {
    const MAX_CONCURRENT = 3;

    // DOM Elements
    const statusDot = document.getElementById('statusDot');
    const btnOn = document.getElementById('btnOn');
    const btnOff = document.getElementById('btnOff');
    const clearHistoryBtn = document.getElementById('clearHistoryBtn');
    const activeTabChip = document.getElementById('activeTabChip');
    const tabChipBadge = document.getElementById('tabChipBadge');
    const tabChipText = document.getElementById('tabChipText');

    const destinationInfo = document.getElementById('destinationInfo');
    const changeDestinationBtn = document.getElementById('changeDestinationBtn');
    const destinationModal = document.getElementById('destinationModal');
    const destSubfolderInput = document.getElementById('destSubfolderInput');
    const destConfirmBtn = document.getElementById('destConfirmBtn');
    const destCancelBtn = document.getElementById('destCancelBtn');

    const singleDownloadBtn = document.getElementById('singleDownloadBtn');
    const bulkDownloadBtn = document.getElementById('bulkDownloadBtn');

    const bulkPanel = document.getElementById('bulkPanel');
    const bulkStatusBadge = document.getElementById('bulkStatusBadge');
    const bulkPauseResumeBtn = document.getElementById('bulkPauseResumeBtn');
    const bulkStopBtn = document.getElementById('bulkStopBtn');
    const bulkDismissBtn = document.getElementById('bulkDismissBtn');
    const bulkProgressSummary = document.getElementById('bulkProgressSummary');
    const bulkCurrentProgressWrap = document.getElementById('bulkCurrentProgressWrap');
    const bulkCurrentProgressFill = document.getElementById('bulkCurrentProgressFill');
    const bulkCurrentPercent = document.getElementById('bulkCurrentPercent');
    const bulkCurrentItemTitle = document.getElementById('bulkCurrentItemTitle');
    const bulkRestartedBanner = document.getElementById('bulkRestartedBanner');

    const stopConfirmModal = document.getElementById('stopConfirmModal');
    const stopConfirmBtn = document.getElementById('stopConfirmBtn');
    const stopCancelBtn = document.getElementById('stopCancelBtn');

    const scanReportModal = document.getElementById('scanReportModal');
    const scanReportTitle = document.getElementById('scanReportTitle');
    const copyDiagnosticsBtn = document.getElementById('copyDiagnosticsBtn');
    const scanIncompleteWarning = document.getElementById('scanIncompleteWarning');
    const selectionSummary = document.getElementById('selectionSummary');
    const selectionSubsummary = document.getElementById('selectionSubsummary');

    const videosSectionTitle = document.getElementById('videosSectionTitle');
    const selectAllBtn = document.getElementById('selectAllBtn');
    const deselectAllBtn = document.getElementById('deselectAllBtn');
    const selectionList = document.getElementById('selectionList');

    const othersSection = document.getElementById('othersSection');
    const othersToggleBtn = document.getElementById('othersToggleBtn');
    const othersToggleArrow = document.getElementById('othersToggleArrow');
    const othersSectionTitle = document.getElementById('othersSectionTitle');
    const includeAllOthersBtn = document.getElementById('includeAllOthersBtn');
    const excludeAllOthersBtn = document.getElementById('excludeAllOthersBtn');
    const othersList = document.getElementById('othersList');

    const selectionHint = document.getElementById('selectionHint');
    const scanCancelBtn = document.getElementById('scanCancelBtn');
    const scanStartBtn = document.getElementById('scanStartBtn');

    const downloadContainer = document.getElementById('downloadContainer');
    const statusContainer = document.getElementById('statusContainer');
    const statusMessage = document.getElementById('statusMessage');
    const statusActionButton = document.getElementById('statusActionButton');
    const downloadAlert = document.getElementById('downloadAlert');
    const blobHandoffBanner = document.getElementById('blobHandoffBanner');

    // Local Caches
    let extensionEnabledCached = false;
    let destinationCached = { mode: 'subfolder', subfolder: 'Drive Videos', configured: false };
    let capturedRequestsCache = {};
    let downloadProgressCache = {};
    let activeTabInfoCache = null;
    let bulkQueueCache = null;
    let historyCache = [];
    let blobHandoffUnsupportedCache = false;

    // Transient selection state for Bulk Download modal
    let scannedVideosCache = [];
    let scannedOthersCache = [];
    let scannedStatsCache = null;
    let scannedDiagnosticsCache = null;
    let selectedFileIdsSet = new Set();
    let previousActiveElement = null;
    let lastToggledIndex = -1;
    let othersExpanded = false;

    const renderedItems = new Map();
    let statusTimeoutId = null;

    function formatBytes(bytes) {
        if (!bytes || bytes <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        let val = bytes;
        let i = 0;
        while (val >= 1024 && i < units.length - 1) {
            val /= 1024;
            i++;
        }
        const decimals = (i === 0) ? 0 : (i === 1 ? 1 : 2);
        return val.toFixed(decimals) + ' ' + units[i];
    }

    function updateToggleUI(isEnabled) {
        extensionEnabledCached = isEnabled;
        btnOn.disabled = isEnabled;
        btnOff.disabled = !isEnabled;
        statusDot.classList.toggle('active', isEnabled);
    }

    function updateActiveTabUI(info) {
        activeTabInfoCache = info;
        if (!info || !info.isDrive) {
            activeTabChip.className = 'tab-chip not-drive';
            tabChipBadge.textContent = 'PAGE';
            tabChipText.textContent = info && info.title ? info.title : 'Not a Drive page';
            singleDownloadBtn.disabled = true;
            bulkDownloadBtn.disabled = true;
            return;
        }

        if (info.isVideo) {
            activeTabChip.className = 'tab-chip is-video';
            tabChipBadge.textContent = 'VIDEO';
            tabChipText.textContent = info.title || ('File ' + info.fileId);
            singleDownloadBtn.disabled = false;
            bulkDownloadBtn.disabled = true;
        } else if (info.isFolder) {
            activeTabChip.className = 'tab-chip is-folder';
            tabChipBadge.textContent = 'FOLDER';
            tabChipText.textContent = info.title || ('Folder ' + info.folderId);
            singleDownloadBtn.disabled = true;
            bulkDownloadBtn.disabled = false;
        } else {
            activeTabChip.className = 'tab-chip not-drive';
            tabChipBadge.textContent = 'DRIVE';
            tabChipText.textContent = info.title || 'Google Drive';
            singleDownloadBtn.disabled = true;
            bulkDownloadBtn.disabled = true;
        }
    }

    function updateDestinationUI(dest) {
        if (!dest) return;
        destinationCached = dest;
        if (dest.mode === 'askEachTime') {
            destinationInfo.innerHTML = 'Save to: <strong>Ask each time (Save-As)</strong>';
        } else {
            const sub = dest.subfolder || 'Drive Videos';
            destinationInfo.innerHTML = 'Save to: <strong>Downloads / ' + escapeHtml(sub) + '</strong>';
        }
    }

    function updateBlobHandoffUI(unsupported) {
        blobHandoffUnsupportedCache = Boolean(unsupported);
        if (blobHandoffBanner) {
            if (blobHandoffUnsupportedCache) {
                blobHandoffBanner.classList.remove('hidden');
            } else {
                blobHandoffBanner.classList.add('hidden');
            }
        }
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function setStatus(text, isError = false, durationMs = null, actionBtnText = null, actionCallback = null) {
        if (statusTimeoutId) {
            clearTimeout(statusTimeoutId);
            statusTimeoutId = null;
        }

        if (!text) {
            statusContainer.classList.add('hidden');
            statusMessage.textContent = '';
            statusActionButton.classList.add('hidden');
            return;
        }

        statusContainer.classList.remove('hidden');
        statusMessage.textContent = text;
        statusMessage.className = 'status-message' + (isError ? ' error' : '');

        if (actionBtnText && actionCallback) {
            statusActionButton.textContent = actionBtnText;
            statusActionButton.classList.remove('hidden');
            statusActionButton.onclick = () => {
                actionCallback();
            };
        } else {
            statusActionButton.classList.add('hidden');
            statusActionButton.onclick = null;
        }

        if (durationMs && !isError) {
            statusTimeoutId = setTimeout(() => {
                statusContainer.classList.add('hidden');
                statusMessage.textContent = '';
                statusActionButton.classList.add('hidden');
                statusTimeoutId = null;
            }, durationMs);
        }
    }

    function clearStatus() {
        if (statusTimeoutId) {
            clearTimeout(statusTimeoutId);
            statusTimeoutId = null;
        }
        statusContainer.classList.add('hidden');
        statusMessage.textContent = '';
        statusActionButton.classList.add('hidden');
    }

    function showEmptyState() {
        if (document.getElementById('emptyState')) return;
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.id = 'emptyState';
        empty.innerHTML =
            '<span class="icon">📡</span>' +
            'Waiting for video sources...<br>' +
            'Open a Google Drive video page to capture requests.<br>' +
            'You can also click <b>⚡ Single Download</b> above.';
        downloadContainer.appendChild(empty);
    }

    function hideEmptyState() {
        const e = document.getElementById('emptyState');
        if (e) e.remove();
    }

    function createVideoItem(req) {
        const item = document.createElement('div');
        item.className = 'video-item';
        item.dataset.requestId = req.requestId;
        if (req.isHistoryOnly) {
            item.dataset.isHistoryOnly = 'true';
        }

        const row = document.createElement('div');
        row.className = 'video-row';

        const info = document.createElement('div');
        info.className = 'video-info';

        const title = document.createElement('div');
        title.className = 'video-title';
        title.textContent = req.videoTitle || 'Untitled';
        title.title = req.videoTitle || '';

        const meta = document.createElement('div');
        meta.className = 'video-meta';
        if (req.quality) {
            const badge = document.createElement('span');
            badge.className = 'quality-badge';
            badge.textContent = req.quality;
            meta.appendChild(badge);
        }
        const metaText = document.createElement('span');
        metaText.textContent = 'MP4';
        meta.appendChild(metaText);

        info.appendChild(title);
        info.appendChild(meta);

        const actions = document.createElement('div');
        actions.className = 'video-actions';

        const dlBtn = document.createElement('button');
        dlBtn.className = 'download-btn';
        dlBtn.textContent = '⬇ Download';
        dlBtn.setAttribute('aria-label', 'Download ' + (req.videoTitle || 'video'));
        dlBtn.addEventListener('click', () => {
            if (dlBtn.disabled) return;
            if (item.dataset.isHistoryOnly === 'true') {
                setStatus('Item recorded in download history.', false, 2000);
                return;
            }
            chrome.runtime.sendMessage({
                type: 'startDownload',
                requestId: req.requestId
            }, (resp) => {
                if (chrome.runtime.lastError) return;
                if (resp && !resp.success) {
                    if (resp.limitReached) {
                        setStatus(getErrorMessage(ERROR_CODES.MAX_CONCURRENT_REACHED), false, 4000);
                    } else {
                        setStatus(resp.error || 'Could not start download.', true);
                    }
                }
            });
        });

        const pauseBtn = document.createElement('button');
        pauseBtn.className = 'ctrl-btn pause-btn hidden';
        pauseBtn.title = 'Pause';
        pauseBtn.textContent = '⏸';
        pauseBtn.setAttribute('aria-label', 'Pause download');
        pauseBtn.addEventListener('click', () => {
            chrome.runtime.sendMessage({
                type: 'pauseDownload',
                requestId: req.requestId
            }, () => { void chrome.runtime.lastError; });
        });

        const resumeBtn = document.createElement('button');
        resumeBtn.className = 'ctrl-btn resume-btn hidden';
        resumeBtn.title = 'Resume';
        resumeBtn.textContent = '▶';
        resumeBtn.setAttribute('aria-label', 'Resume download');
        resumeBtn.addEventListener('click', () => {
            chrome.runtime.sendMessage({
                type: 'resumeDownload',
                requestId: req.requestId
            }, () => { void chrome.runtime.lastError; });
        });

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'ctrl-btn cancel-btn hidden';
        cancelBtn.title = 'Cancel';
        cancelBtn.textContent = '✕';
        cancelBtn.setAttribute('aria-label', 'Cancel download');
        cancelBtn.addEventListener('click', () => {
            chrome.runtime.sendMessage({
                type: 'cancelDownload',
                requestId: req.requestId
            }, () => { void chrome.runtime.lastError; });
        });

        actions.appendChild(dlBtn);
        actions.appendChild(pauseBtn);
        actions.appendChild(resumeBtn);
        actions.appendChild(cancelBtn);

        row.appendChild(info);
        row.appendChild(actions);

        const progressWrap = document.createElement('div');
        progressWrap.className = 'progress-wrap hidden';

        const progressBar = document.createElement('div');
        progressBar.className = 'progress-bar';
        const progressFill = document.createElement('div');
        progressFill.className = 'progress-fill';
        progressBar.appendChild(progressFill);

        const progressText = document.createElement('div');
        progressText.className = 'progress-text';
        const pp = document.createElement('span');
        pp.className = 'pp';
        pp.textContent = '0%';
        const ps = document.createElement('span');
        ps.className = 'ps';
        ps.textContent = 'Starting...';
        progressText.appendChild(pp);
        progressText.appendChild(ps);

        progressWrap.appendChild(progressBar);
        progressWrap.appendChild(progressText);

        item.appendChild(row);
        item.appendChild(progressWrap);

        return item;
    }

    function applyProgress(item, prog) {
        if (!prog) return;

        const progressWrap = item.querySelector('.progress-wrap');
        const progressFill = item.querySelector('.progress-fill');
        const dlBtn        = item.querySelector('.download-btn');
        const pauseBtn     = item.querySelector('.pause-btn');
        const resumeBtn    = item.querySelector('.resume-btn');
        const cancelBtn    = item.querySelector('.cancel-btn');
        const pp           = item.querySelector('.pp');
        const ps           = item.querySelector('.ps');

        const percent = Math.max(0, Math.min(100, prog.percent || 0));
        progressFill.style.width = percent + '%';
        pp.textContent = percent + '%';

        const doneStr = formatBytes(prog.completed || 0);
        const totStr  = formatBytes(prog.total || 0);
        const progressLabel = (!prog.total || prog.total === 0)
            ? doneStr + ' / calculating...'
            : doneStr + ' / ' + totStr;

        const st = prog.status;
        if (st === 'starting') {
            progressWrap.classList.remove('hidden');
            progressFill.className = 'progress-fill';
            progressFill.style.width = '0%';
            pp.textContent = '0%';
            ps.textContent = 'Starting...';
            dlBtn.classList.add('hidden');
            pauseBtn.classList.remove('hidden');
            resumeBtn.classList.add('hidden');
            cancelBtn.classList.remove('hidden');
            item.classList.add('is-active');
        } else if (st === 'downloading') {
            progressWrap.classList.remove('hidden');
            progressFill.className = 'progress-fill';
            ps.textContent = progressLabel;
            dlBtn.classList.add('hidden');
            pauseBtn.classList.remove('hidden');
            resumeBtn.classList.add('hidden');
            cancelBtn.classList.remove('hidden');
            item.classList.add('is-active');
        } else if (st === 'saving') {
            progressWrap.classList.remove('hidden');
            progressFill.className = 'progress-fill saving';
            progressFill.style.width = '100%';
            pp.textContent = '100%';
            ps.textContent = 'Saving file to disk...';
            dlBtn.classList.add('hidden');
            pauseBtn.classList.add('hidden');
            resumeBtn.classList.add('hidden');
            cancelBtn.classList.add('hidden');
            item.classList.add('is-active');
        } else if (st === 'paused') {
            progressWrap.classList.remove('hidden');
            progressFill.className = 'progress-fill';
            ps.textContent = 'Paused at ' + progressLabel;
            dlBtn.classList.add('hidden');
            pauseBtn.classList.add('hidden');
            resumeBtn.classList.remove('hidden');
            cancelBtn.classList.remove('hidden');
            item.classList.add('is-active');
        } else if (st === 'completed') {
            progressWrap.classList.remove('hidden');
            progressFill.className = 'progress-fill completed';
            ps.textContent = prog.note || ('Saved to downloads (' + (prog.total ? formatBytes(prog.total) : doneStr) + ')');
            if (item.dataset.isHistoryOnly === 'true') {
                dlBtn.classList.add('hidden');
            } else {
                dlBtn.classList.remove('hidden');
                dlBtn.textContent = '⬇ Re-download';
            }
            pauseBtn.classList.add('hidden');
            resumeBtn.classList.add('hidden');
            cancelBtn.classList.add('hidden');
            item.classList.remove('is-active');
        } else if (st === 'cancelled') {
            progressWrap.classList.remove('hidden');
            progressFill.className = 'progress-fill error';
            ps.textContent = 'Cancelled' + (prog.completed ? ' at ' + doneStr : '');
            if (item.dataset.isHistoryOnly === 'true') {
                dlBtn.classList.add('hidden');
            } else {
                dlBtn.classList.remove('hidden');
                dlBtn.textContent = 'Retry';
            }
            pauseBtn.classList.add('hidden');
            resumeBtn.classList.add('hidden');
            cancelBtn.classList.add('hidden');
            item.classList.remove('is-active');
        } else if (st === 'interrupted' || st === 'error' || st === 'failed') {
            progressWrap.classList.remove('hidden');
            progressFill.className = 'progress-fill error';
            ps.textContent = 'Failed: ' + (prog.error || 'Download failed');
            if (item.dataset.isHistoryOnly === 'true') {
                dlBtn.classList.add('hidden');
            } else {
                dlBtn.classList.remove('hidden');
                dlBtn.textContent = 'Retry';
            }
            pauseBtn.classList.add('hidden');
            resumeBtn.classList.add('hidden');
            cancelBtn.classList.add('hidden');
            item.classList.remove('is-active');
        }
    }

    function syncList(requests, progress, history = historyCache) {
        const matching = [];
        const seenKeys = new Set();

        // 1. Live captured requests
        for (const requestId in requests) {
            const req = requests[requestId];
            if (!req.lastItagUrl || !req.videoTitle) continue;
            const key = req.fileId || req.videoTitle;
            seenKeys.add(key);
            matching.push(Object.assign({ requestId: requestId, key: key }, req));
        }

        // 2. Historical records not currently represented in live captures
        if (Array.isArray(history)) {
            for (const h of history) {
                const key = h.fileId || h.key || h.name;
                if (!seenKeys.has(key)) {
                    seenKeys.add(key);
                    matching.push({
                        requestId: 'hist_' + (h.key || h.fileId || h.name),
                        key: key,
                        fileId: h.fileId,
                        videoTitle: h.name,
                        quality: 'HD',
                        capturedAt: h.finishedAt || 0,
                        isHistoryOnly: true,
                        historyStatus: h.status,
                        historyError: h.error,
                        historyNote: h.note,
                        historyBytes: h.bytes
                    });
                }
            }
        }

        matching.sort((a, b) => {
            const ta = a.capturedAt || a.timestamp || 0;
            const tb = b.capturedAt || b.timestamp || 0;
            return tb - ta;
        });

        if (matching.length === 0) {
            if (renderedItems.size === 0) {
                showEmptyState();
            }
        } else {
            hideEmptyState();
        }

        const seenIds = new Set();
        matching.forEach((req, idx) => {
            seenIds.add(req.requestId);
            let item = renderedItems.get(req.requestId);

            if (!item) {
                item = createVideoItem(req);
                renderedItems.set(req.requestId, item);
            } else {
                const titleEl = item.querySelector('.video-title');
                if (titleEl && titleEl.textContent !== (req.videoTitle || 'Untitled')) {
                    titleEl.textContent = req.videoTitle || 'Untitled';
                    titleEl.title = req.videoTitle || '';
                }
                const badge = item.querySelector('.quality-badge');
                if (badge && req.quality && badge.textContent !== req.quality) {
                    badge.textContent = req.quality;
                }
            }

            const historyLabel = document.getElementById('historyLabel');
            const currentChildren = Array.from(downloadContainer.children).filter(el => el !== historyLabel);
            const expectedIndex = idx;
            if (currentChildren[expectedIndex] !== item) {
                if (expectedIndex === 0) {
                    downloadContainer.insertBefore(item, historyLabel.nextSibling);
                } else {
                    const prev = currentChildren[expectedIndex - 1];
                    if (prev && prev.nextSibling) {
                        downloadContainer.insertBefore(item, prev.nextSibling);
                    } else {
                        downloadContainer.appendChild(item);
                    }
                }
            }

            if (req.isHistoryOnly) {
                applyProgress(item, {
                    status: req.historyStatus,
                    completed: req.historyBytes,
                    total: req.historyBytes,
                    percent: req.historyStatus === 'completed' ? 100 : 0,
                    error: req.historyError,
                    note: req.historyNote
                });
            } else if (progress && progress[req.requestId]) {
                applyProgress(item, progress[req.requestId]);
            }
        });

        for (const [rid, el] of renderedItems.entries()) {
            if (!seenIds.has(rid)) {
                el.remove();
                renderedItems.delete(rid);
            }
        }

        let hasActive = false;
        if (progress) {
            for (const rid in progress) {
                const st = progress[rid] && progress[rid].status;
                if (st === 'starting' || st === 'downloading' || st === 'saving' || st === 'paused') {
                    hasActive = true;
                    break;
                }
            }
        }
        downloadAlert.classList.toggle('hidden', !hasActive);

        applyConcurrencyLimit();
    }

    function countActiveDownloads() {
        let count = 0;
        for (const rid in downloadProgressCache) {
            const st = downloadProgressCache[rid] && downloadProgressCache[rid].status;
            if (st === 'starting' || st === 'downloading' || st === 'saving' || st === 'paused') {
                count++;
            }
        }
        return count;
    }

    function isItemDownloading(rid) {
        const st = downloadProgressCache[rid] && downloadProgressCache[rid].status;
        return st === 'starting' || st === 'downloading' || st === 'saving' || st === 'paused';
    }

    function applyConcurrencyLimit() {
        const activeCount = countActiveDownloads();
        const limitReached = activeCount >= MAX_CONCURRENT;

        renderedItems.forEach((item, rid) => {
            if (isItemDownloading(rid)) return;

            const dlBtn = item.querySelector('.download-btn');
            if (!dlBtn) return;

            if (limitReached) {
                dlBtn.disabled = true;
                dlBtn.classList.add('disabled-limit');
                if (dlBtn.textContent.indexOf('⬇') === 0 || dlBtn.textContent === 'Retry' || dlBtn.textContent === '⬇ Re-download') {
                    dlBtn.dataset.originalText = dlBtn.textContent;
                    dlBtn.textContent = '⏳ Wait';
                    dlBtn.title = 'Maximum ' + MAX_CONCURRENT + ' concurrent downloads. Waiting for one to finish.';
                }
            } else {
                dlBtn.disabled = false;
                dlBtn.classList.remove('disabled-limit');
                if (dlBtn.dataset.originalText) {
                    dlBtn.textContent = dlBtn.dataset.originalText;
                    delete dlBtn.dataset.originalText;
                }
                dlBtn.title = '';
            }
        });
    }

    function updateBulkQueueUI(queue) {
        bulkQueueCache = queue;
        const ctrl = getBulkControlsState(queue);

        if (!ctrl.showPanel) {
            bulkPanel.classList.add('hidden');
            return;
        }

        bulkPanel.classList.remove('hidden');

        // Status badge
        bulkStatusBadge.textContent = ctrl.badgeText;
        bulkStatusBadge.className = ctrl.badgeClass;

        // Pause / Resume button
        bulkPauseResumeBtn.textContent = ctrl.pause.label;
        bulkPauseResumeBtn.disabled = !ctrl.pause.enabled;
        if (ctrl.pause.visible) {
            bulkPauseResumeBtn.classList.remove('hidden');
        } else {
            bulkPauseResumeBtn.classList.add('hidden');
        }

        // Stop button
        bulkStopBtn.disabled = !ctrl.stop.enabled;
        if (ctrl.stop.visible) {
            bulkStopBtn.classList.remove('hidden');
        } else {
            bulkStopBtn.classList.add('hidden');
        }

        // Dismiss button
        if (ctrl.dismissVisible) {
            bulkDismissBtn.classList.remove('hidden');
        } else {
            bulkDismissBtn.classList.add('hidden');
        }

        // Restarted banner
        if (queue.restartedBanner) {
            bulkRestartedBanner.textContent = queue.restartedBanner;
            bulkRestartedBanner.classList.remove('hidden');
        } else {
            bulkRestartedBanner.classList.add('hidden');
        }

        // Summary: e.g. "7 / 37 · 1 failed"
        bulkProgressSummary.textContent = ctrl.summaryText;

        // Current item progress
        const activeItem = queue.items && typeof queue.index === 'number' ? queue.items[queue.index] : null;
        if (ctrl.showCurrentItem && activeItem) {
            bulkCurrentProgressWrap.classList.remove('hidden');
            bulkCurrentItemTitle.textContent = activeItem.name || 'Processing video...';
            const pct = activeItem.percent || 0;
            bulkCurrentPercent.textContent = pct + '%';
            bulkCurrentProgressFill.style.width = pct + '%';
        } else {
            bulkCurrentProgressWrap.classList.add('hidden');
        }
    }

    // ON/OFF toggle handling
    function handleToggleClick(targetState) {
        updateToggleUI(targetState);
        chrome.runtime.sendMessage({
            type: 'setEnabled',
            enabled: targetState
        }, (response) => {
            if (chrome.runtime.lastError) return;
            if (response && response.success) {
                if (targetState && response.isDriveTab === false) {
                    setStatus('Capture turned ON. Open a Google Drive video page to capture streams.', false, 5000);
                } else if (!targetState) {
                    setStatus('Extension turned OFF. Passive capture detached.', false, 3000);
                } else {
                    clearStatus();
                }
            }
        });
    }

    btnOn.addEventListener('click', () => handleToggleClick(true));
    btnOff.addEventListener('click', () => handleToggleClick(false));

    // Clear History
    clearHistoryBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'clearHistory' }, () => {
            chrome.runtime.sendMessage({ type: 'getState' }, (resp) => {
                if (chrome.runtime.lastError || !resp) return;
                capturedRequestsCache = resp.requests || {};
                downloadProgressCache = resp.progress || {};
                historyCache = resp.history || [];
                updateBulkQueueUI(resp.bulkQueue);
                syncList(capturedRequestsCache, downloadProgressCache, historyCache);
                setStatus('History cleared.', false, 2000);
            });
        });
    });

    // Destination UI & Modal
    changeDestinationBtn.addEventListener('click', () => {
        destSubfolderInput.value = destinationCached.subfolder || 'Drive Videos';
        const radios = document.getElementsByName('destMode');
        radios.forEach(r => {
            r.checked = (r.value === destinationCached.mode);
        });
        destinationModal.classList.remove('hidden');
    });

    destCancelBtn.addEventListener('click', () => {
        destinationModal.classList.add('hidden');
    });

    destConfirmBtn.addEventListener('click', () => {
        const radios = document.getElementsByName('destMode');
        let selectedMode = 'subfolder';
        radios.forEach(r => { if (r.checked) selectedMode = r.value; });

        const subfolder = destSubfolderInput.value.trim() || 'Drive Videos';
        const newDest = {
            mode: selectedMode,
            subfolder: subfolder,
            configured: true
        };

        chrome.runtime.sendMessage({
            type: 'setDestination',
            destination: newDest
        }, () => {
            updateDestinationUI(newDest);
            destinationModal.classList.add('hidden');
            setStatus('Save destination updated.', false, 2500);
        });
    });

    // Single Download Button
    singleDownloadBtn.addEventListener('click', () => {
        setStatus('Starting Single Download...', false);
        chrome.runtime.sendMessage({ type: 'singleDownload' }, (response) => {
            if (chrome.runtime.lastError) {
                setStatus('Failed to communicate with service worker.', true);
                return;
            }
            if (!response) return;

            if (response.needsDestination) {
                destinationModal.classList.remove('hidden');
                return;
            }

            if (!response.success) {
                const msg = getErrorMessage(response.error, response.message);
                if (response.error === ERROR_CODES.NO_MEDIA_REQUEST_CAPTURED) {
                    setStatus(msg, true, null, 'Reload tab & capture', () => {
                        chrome.runtime.sendMessage({ type: 'reloadTabAndCapture', tabId: response.tabId });
                    });
                } else {
                    setStatus(msg, true);
                }
            } else {
                setStatus('Download started.', false, 3000);
            }
        });
    });

    function updateSelectionUI() {
        const selState = computeSelectionState(scannedVideosCache, scannedOthersCache, selectedFileIdsSet);
        selectionSummary.textContent = selState.summaryText;

        selectAllBtn.disabled = !selState.selectAllEnabled;
        deselectAllBtn.disabled = !selState.deselectAllEnabled;

        includeAllOthersBtn.disabled = !selState.includeAllOthersEnabled;
        excludeAllOthersBtn.disabled = !selState.excludeAllOthersEnabled;

        scanStartBtn.disabled = !selState.startEnabled;
        scanStartBtn.textContent = selState.startLabel;

        if (!selState.startEnabled) {
            selectionHint.classList.remove('hidden');
        } else {
            selectionHint.classList.add('hidden');
        }
    }

    function buildSectionRows(container, items, defaultChecked, isOther) {
        const completedFileIds = new Set(
            (historyCache || [])
                .filter(h => h && h.status === 'completed' && h.fileId)
                .map(h => h.fileId)
        );

        const fragment = document.createDocumentFragment();
        items.forEach((item, idx) => {
            const label = document.createElement('label');
            label.className = 'selection-row' + (isOther ? ' other-row' : '');
            label.htmlFor = `chk-${isOther ? 'other' : 'vid'}-${idx}`;

            const chk = document.createElement('input');
            chk.type = 'checkbox';
            chk.className = 'selection-checkbox';
            chk.id = `chk-${isOther ? 'other' : 'vid'}-${idx}`;
            chk.dataset.fileId = item.fileId;
            chk.dataset.section = isOther ? 'others' : 'videos';
            chk.dataset.index = String(idx);
            chk.value = item.fileId;
            chk.checked = defaultChecked;
            chk.setAttribute('aria-label', item.name || `File ${idx + 1}`);

            const idxSpan = document.createElement('span');
            idxSpan.className = 'selection-index';
            idxSpan.textContent = `${idx + 1}.`;

            const nameSpan = document.createElement('span');
            nameSpan.className = 'selection-name';
            nameSpan.dir = 'auto';
            nameSpan.title = item.name || (isOther ? 'Untitled File' : 'Untitled Video');
            nameSpan.textContent = item.name || (isOther ? 'Untitled File' : 'Untitled Video');

            label.appendChild(chk);
            label.appendChild(idxSpan);
            label.appendChild(nameSpan);

            if (isOther && item.reason) {
                const reasonBadge = document.createElement('span');
                reasonBadge.className = 'others-reason-badge';
                reasonBadge.textContent = item.reason;
                label.appendChild(reasonBadge);
            }

            if (completedFileIds.has(item.fileId)) {
                const badge = document.createElement('span');
                badge.className = 'selection-badge';
                badge.textContent = 'Downloaded';
                badge.title = 'Already completed in download history';
                label.appendChild(badge);
            }

            fragment.appendChild(label);
        });

        container.replaceChildren(fragment);
    }

    function openSelectionModal(videos, others, totalScanned, subfoldersSkipped, stats, diagnostics) {
        scannedVideosCache = Array.isArray(videos) ? videos : [];
        scannedOthersCache = Array.isArray(others) ? others : [];
        scannedStatsCache = stats || null;
        scannedDiagnosticsCache = diagnostics || { stats, items: [] };

        // Videos checked by default, Others unchecked by default
        selectedFileIdsSet = new Set(scannedVideosCache.map(v => v.fileId));
        lastToggledIndex = -1;
        othersExpanded = false;
        previousActiveElement = document.activeElement;

        scanReportTitle.textContent = 'Select videos to download';

        const total = totalScanned || (scannedVideosCache.length + scannedOthersCache.length + (subfoldersSkipped || 0));
        selectionSubsummary.textContent = `${total} items scanned · ${scannedVideosCache.length} videos · ${scannedOthersCache.length} other files · ${subfoldersSkipped || 0} subfolders skipped`;

        // Check if scan may be incomplete
        if (stats && (stats.stoppedBy === 'maxSteps' || stats.stoppedBy === 'maxTime')) {
            scanIncompleteWarning.classList.remove('hidden');
        } else {
            scanIncompleteWarning.classList.add('hidden');
        }

        videosSectionTitle.textContent = `Videos (${scannedVideosCache.length})`;
        othersSectionTitle.textContent = `Other files — not detected as video (${scannedOthersCache.length})`;

        othersToggleBtn.setAttribute('aria-expanded', 'false');
        othersToggleArrow.classList.remove('expanded');
        othersList.classList.add('hidden');

        if (scannedOthersCache.length > 0) {
            othersSection.classList.remove('hidden');
        } else {
            othersSection.classList.add('hidden');
        }

        buildSectionRows(selectionList, scannedVideosCache, true, false);
        buildSectionRows(othersList, scannedOthersCache, false, true);

        updateSelectionUI();

        scanReportModal.classList.remove('hidden');
        selectAllBtn.focus();
    }

    function closeSelectionModal() {
        scanReportModal.classList.add('hidden');
        if (previousActiveElement && typeof previousActiveElement.focus === 'function') {
            try {
                previousActiveElement.focus();
            } catch (e) {}
        }
    }

    // Delegated change listener on selection lists
    function handleListChange(e) {
        const target = e.target;
        if (!target || !target.classList.contains('selection-checkbox')) return;
        const fileId = target.dataset.fileId;
        if (target.checked) {
            selectedFileIdsSet.add(fileId);
        } else {
            selectedFileIdsSet.delete(fileId);
        }
        updateSelectionUI();
    }
    selectionList.addEventListener('change', handleListChange);
    othersList.addEventListener('change', handleListChange);

    // Delegated click listener for Shift+click range selection within a section
    function handleListClick(e, listEl) {
        const row = e.target.closest('.selection-row');
        if (!row) return;
        const chk = row.querySelector('.selection-checkbox');
        if (!chk) return;

        if (e.target.tagName === 'LABEL') return;

        const currIdx = parseInt(chk.dataset.index, 10);
        if (Number.isNaN(currIdx)) return;

        if (e.shiftKey && lastToggledIndex !== -1 && lastToggledIndex !== currIdx) {
            const start = Math.min(lastToggledIndex, currIdx);
            const end = Math.max(lastToggledIndex, currIdx);
            const targetState = chk.checked;
            const allCheckboxes = listEl.querySelectorAll('.selection-checkbox');
            for (let i = start; i <= end; i++) {
                const c = allCheckboxes[i];
                if (c) {
                    c.checked = targetState;
                    if (targetState) {
                        selectedFileIdsSet.add(c.dataset.fileId);
                    } else {
                        selectedFileIdsSet.delete(c.dataset.fileId);
                    }
                }
            }
            updateSelectionUI();
        }
        lastToggledIndex = currIdx;
    }
    selectionList.addEventListener('click', (e) => handleListClick(e, selectionList));
    othersList.addEventListener('click', (e) => handleListClick(e, othersList));

    // Section 1 Controls: Select All / Deselect All videos
    selectAllBtn.addEventListener('click', () => {
        const checkboxes = selectionList.querySelectorAll('.selection-checkbox');
        for (let i = 0; i < checkboxes.length; i++) {
            checkboxes[i].checked = true;
            selectedFileIdsSet.add(checkboxes[i].dataset.fileId);
        }
        updateSelectionUI();
    });

    deselectAllBtn.addEventListener('click', () => {
        const checkboxes = selectionList.querySelectorAll('.selection-checkbox');
        for (let i = 0; i < checkboxes.length; i++) {
            checkboxes[i].checked = false;
            selectedFileIdsSet.delete(checkboxes[i].dataset.fileId);
        }
        updateSelectionUI();
    });

    // Section 2 Controls: Include all / Exclude all other files
    includeAllOthersBtn.addEventListener('click', () => {
        const checkboxes = othersList.querySelectorAll('.selection-checkbox');
        for (let i = 0; i < checkboxes.length; i++) {
            checkboxes[i].checked = true;
            selectedFileIdsSet.add(checkboxes[i].dataset.fileId);
        }
        updateSelectionUI();
    });

    excludeAllOthersBtn.addEventListener('click', () => {
        const checkboxes = othersList.querySelectorAll('.selection-checkbox');
        for (let i = 0; i < checkboxes.length; i++) {
            checkboxes[i].checked = false;
            selectedFileIdsSet.delete(checkboxes[i].dataset.fileId);
        }
        updateSelectionUI();
    });

    // Section 2 Toggle
    othersToggleBtn.addEventListener('click', () => {
        othersExpanded = !othersExpanded;
        othersToggleBtn.setAttribute('aria-expanded', String(othersExpanded));
        othersToggleArrow.classList.toggle('expanded', othersExpanded);
        othersList.classList.toggle('hidden', !othersExpanded);
    });

    // Copy Scan Diagnostics button
    copyDiagnosticsBtn.addEventListener('click', () => {
        const data = scannedDiagnosticsCache || {
            stats: scannedStatsCache,
            videos: scannedVideosCache,
            others: scannedOthersCache
        };
        const jsonStr = JSON.stringify(data, null, 2);

        const showNotice = () => {
            const originalText = copyDiagnosticsBtn.textContent;
            copyDiagnosticsBtn.textContent = 'Diagnostics copied!';
            setTimeout(() => {
                copyDiagnosticsBtn.textContent = originalText;
            }, 2000);
        };

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(jsonStr).then(showNotice).catch(() => {
                fallbackCopyText(jsonStr, showNotice);
            });
        } else {
            fallbackCopyText(jsonStr, showNotice);
        }
    });

    function fallbackCopyText(text, cb) {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            if (cb) cb();
        } catch (e) {}
    }

    // Keyboard navigation and modal focus trap
    scanReportModal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeSelectionModal();
            clearStatus();
            return;
        }
        if (e.key === 'Tab') {
            const focusable = Array.from(scanReportModal.querySelectorAll(
                'button:not(:disabled), input[type="checkbox"]:not(:disabled)'
            )).filter(el => !el.closest('.hidden'));

            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }
    });

    // Bulk Download Button
    bulkDownloadBtn.addEventListener('click', () => {
        setStatus('Scanning folder for videos...', false);
        chrome.runtime.sendMessage({ type: 'bulkScan' }, (response) => {
            if (chrome.runtime.lastError) {
                setStatus('Failed to scan folder.', true);
                return;
            }
            if (!response) return;

            if (response.needsDestination) {
                destinationModal.classList.remove('hidden');
                return;
            }

            if (!response.success) {
                setStatus(getErrorMessage(response.error, response.message), true);
                return;
            }

            clearStatus();
            openSelectionModal(
                response.videos || [],
                response.others || [],
                response.totalScanned || 0,
                response.subfoldersSkipped || 0,
                response.stats || null,
                response.diagnostics || null
            );
        });
    });

    scanCancelBtn.addEventListener('click', () => {
        closeSelectionModal();
        clearStatus();
    });

    scanStartBtn.addEventListener('click', () => {
        const selectedIds = Array.from(selectedFileIdsSet);
        if (!selectedIds.length) return;

        closeSelectionModal();

        chrome.runtime.sendMessage({
            type: 'bulkStart',
            selectedFileIds: selectedIds
        }, (resp) => {
            if (chrome.runtime.lastError) {
                setStatus('Failed to communicate with service worker.', true);
                return;
            }
            if (resp && !resp.success) {
                setStatus(getErrorMessage(resp.error, resp.message), true);
            }
        });
    });

    // Bulk Controls
    bulkPauseResumeBtn.addEventListener('click', () => {
        if (!bulkQueueCache) return;
        if (bulkQueueCache.state === 'running') {
            chrome.runtime.sendMessage({ type: 'bulkPause' });
        } else if (bulkQueueCache.state === 'paused') {
            chrome.runtime.sendMessage({ type: 'bulkResume' });
        }
    });

    bulkStopBtn.addEventListener('click', () => {
        if (!bulkQueueCache || (bulkQueueCache.state !== 'running' && bulkQueueCache.state !== 'pausing' && bulkQueueCache.state !== 'paused')) {
            return;
        }
        stopConfirmModal.classList.remove('hidden');
    });

    stopCancelBtn.addEventListener('click', () => {
        stopConfirmModal.classList.add('hidden');
    });

    stopConfirmBtn.addEventListener('click', () => {
        stopConfirmModal.classList.add('hidden');
        if (!bulkQueueCache || (bulkQueueCache.state !== 'running' && bulkQueueCache.state !== 'pausing' && bulkQueueCache.state !== 'paused')) {
            setStatus('Bulk queue is already finished or stopped.', false, 2000);
            return;
        }
        chrome.runtime.sendMessage({ type: 'bulkStop' });
    });

    bulkDismissBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'bulkDismiss' }, () => {
            bulkPanel.classList.add('hidden');
            bulkQueueCache = null;
        });
    });

    // Initial State Fetch
    chrome.runtime.sendMessage({ type: 'getState' }, (resp) => {
        if (chrome.runtime.lastError || !resp) return;
        updateToggleUI(resp.extensionEnabled);
        updateDestinationUI(resp.destination);
        updateActiveTabUI(resp.activeTabInfo);
        updateBulkQueueUI(resp.bulkQueue);
        updateBlobHandoffUI(resp.blobHandoffUnsupported);
        capturedRequestsCache = resp.requests || {};
        downloadProgressCache = resp.progress || {};
        historyCache = resp.history || [];
        syncList(capturedRequestsCache, downloadProgressCache, historyCache);
    });

    // React to storage changes from service worker
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;

        if (changes.extensionEnabled) {
            updateToggleUI(changes.extensionEnabled.newValue);
        }
        if (changes.destination) {
            updateDestinationUI(changes.destination.newValue);
        }
        if (changes.bulkQueue) {
            updateBulkQueueUI(changes.bulkQueue.newValue);
        }
        if (changes.blobHandoffUnsupported !== undefined) {
            updateBlobHandoffUI(changes.blobHandoffUnsupported.newValue);
        }
        if (changes.downloadHistory) {
            historyCache = changes.downloadHistory.newValue || [];
            syncList(capturedRequestsCache, downloadProgressCache, historyCache);
        }
        if (changes.capturedRequests) {
            capturedRequestsCache = changes.capturedRequests.newValue || {};
            syncList(capturedRequestsCache, downloadProgressCache, historyCache);
        }
        if (changes.downloadProgress) {
            downloadProgressCache = changes.downloadProgress.newValue || {};
            syncList(capturedRequestsCache, downloadProgressCache, historyCache);
        }
    });

    // Poll active tab info occasionally or when activated
    setInterval(() => {
        chrome.runtime.sendMessage({ type: 'getActiveTabInfo' }, (resp) => {
            if (chrome.runtime.lastError || !resp) return;
            updateActiveTabUI(resp.activeTabInfo);
        });
    }, 2000);
});

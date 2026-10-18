// Side Panel Controller
import { ERROR_CODES, getErrorMessage } from './src/errors.js';

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
    const scanReportText = document.getElementById('scanReportText');
    const scanCancelBtn = document.getElementById('scanCancelBtn');
    const scanStartBtn = document.getElementById('scanStartBtn');

    const downloadContainer = document.getElementById('downloadContainer');
    const statusContainer = document.getElementById('statusContainer');
    const statusMessage = document.getElementById('statusMessage');
    const statusActionButton = document.getElementById('statusActionButton');
    const downloadAlert = document.getElementById('downloadAlert');

    // Local Caches
    let extensionEnabledCached = false;
    let destinationCached = { mode: 'subfolder', subfolder: 'Drive Videos', configured: false };
    let capturedRequestsCache = {};
    let downloadProgressCache = {};
    let activeTabInfoCache = null;
    let bulkQueueCache = null;

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
            ps.textContent = 'Saved to downloads (' + (prog.total ? formatBytes(prog.total) : doneStr) + ')';
            dlBtn.classList.remove('hidden');
            dlBtn.textContent = '⬇ Re-download';
            pauseBtn.classList.add('hidden');
            resumeBtn.classList.add('hidden');
            cancelBtn.classList.add('hidden');
            item.classList.remove('is-active');
        } else if (st === 'cancelled') {
            progressWrap.classList.remove('hidden');
            progressFill.className = 'progress-fill error';
            ps.textContent = 'Cancelled' + (prog.completed ? ' at ' + doneStr : '');
            dlBtn.classList.remove('hidden');
            dlBtn.textContent = 'Retry';
            pauseBtn.classList.add('hidden');
            resumeBtn.classList.add('hidden');
            cancelBtn.classList.add('hidden');
            item.classList.remove('is-active');
        } else if (st === 'interrupted' || st === 'error') {
            progressWrap.classList.remove('hidden');
            progressFill.className = 'progress-fill error';
            ps.textContent = 'Failed: ' + (prog.error || 'Download failed');
            dlBtn.classList.remove('hidden');
            dlBtn.textContent = 'Retry';
            pauseBtn.classList.add('hidden');
            resumeBtn.classList.add('hidden');
            cancelBtn.classList.add('hidden');
            item.classList.remove('is-active');
        }
    }

    function syncList(requests, progress) {
        const matching = [];
        for (const requestId in requests) {
            const req = requests[requestId];
            if (!req.lastItagUrl || !req.videoTitle) continue;
            matching.push(Object.assign({ requestId: requestId }, req));
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

            if (progress && progress[req.requestId]) {
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
        if (!queue || queue.state === 'idle') {
            bulkPanel.classList.add('hidden');
            return;
        }

        bulkPanel.classList.remove('hidden');

        // Status badge
        bulkStatusBadge.textContent = queue.state;
        bulkStatusBadge.className = 'bulk-status-badge ' + (queue.state || 'running');

        // Pause / Resume button
        if (queue.state === 'paused') {
            bulkPauseResumeBtn.textContent = '▶ Resume';
            bulkPauseResumeBtn.disabled = false;
        } else if (queue.state === 'running') {
            bulkPauseResumeBtn.textContent = '⏸ Pause';
            bulkPauseResumeBtn.disabled = false;
        } else if (queue.state === 'pausing') {
            bulkPauseResumeBtn.textContent = 'Pausing...';
            bulkPauseResumeBtn.disabled = true;
        } else {
            bulkPauseResumeBtn.disabled = true;
        }

        // Restarted banner
        if (queue.restartedBanner) {
            bulkRestartedBanner.textContent = queue.restartedBanner;
            bulkRestartedBanner.classList.remove('hidden');
        } else {
            bulkRestartedBanner.classList.add('hidden');
        }

        // Summary: e.g. "7 / 37 · 1 failed"
        const total = queue.items ? queue.items.length : 0;
        const completed = queue.items ? queue.items.filter(i => i.state === 'completed').length : 0;
        const failed = queue.items ? queue.items.filter(i => i.state === 'failed').length : 0;
        bulkProgressSummary.textContent = `${completed} / ${total} · ${failed} failed`;

        // Current item progress
        const activeItem = queue.items && typeof queue.index === 'number' ? queue.items[queue.index] : null;
        if (activeItem && (queue.state === 'running' || queue.state === 'paused' || queue.state === 'pausing')) {
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
            renderedItems.forEach((el, rid) => {
                const st = (downloadProgressCache[rid] || {}).status;
                if (st !== 'starting' && st !== 'downloading' && st !== 'saving' && st !== 'paused') {
                    el.remove();
                    renderedItems.delete(rid);
                }
            });
            if (renderedItems.size === 0) {
                showEmptyState();
            }
            setStatus('History cleared.', false, 2000);
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

            // Show scan report modal
            const videos = response.videos || [];
            scanReportTitle.textContent = 'Folder Scan Complete';
            scanReportText.textContent = `Scanned ${response.totalScanned || 0} items. Found ${videos.length} videos (${response.subfoldersSkipped || 0} subfolders skipped). Ready to start sequential bulk download?`;
            scanReportModal.classList.remove('hidden');
        });
    });

    scanCancelBtn.addEventListener('click', () => {
        scanReportModal.classList.add('hidden');
        clearStatus();
    });

    scanStartBtn.addEventListener('click', () => {
        scanReportModal.classList.add('hidden');
        chrome.runtime.sendMessage({ type: 'bulkStart' }, (resp) => {
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
        stopConfirmModal.classList.remove('hidden');
    });

    stopCancelBtn.addEventListener('click', () => {
        stopConfirmModal.classList.add('hidden');
    });

    stopConfirmBtn.addEventListener('click', () => {
        stopConfirmModal.classList.add('hidden');
        chrome.runtime.sendMessage({ type: 'bulkStop' });
    });

    // Initial State Fetch
    chrome.runtime.sendMessage({ type: 'getState' }, (resp) => {
        if (chrome.runtime.lastError || !resp) return;
        updateToggleUI(resp.extensionEnabled);
        updateDestinationUI(resp.destination);
        updateActiveTabUI(resp.activeTabInfo);
        updateBulkQueueUI(resp.bulkQueue);
        capturedRequestsCache = resp.requests || {};
        downloadProgressCache = resp.progress || {};
        syncList(capturedRequestsCache, downloadProgressCache);
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
        if (changes.capturedRequests) {
            capturedRequestsCache = changes.capturedRequests.newValue || {};
            syncList(capturedRequestsCache, downloadProgressCache);
        }
        if (changes.downloadProgress) {
            downloadProgressCache = changes.downloadProgress.newValue || {};
            syncList(capturedRequestsCache, downloadProgressCache);
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

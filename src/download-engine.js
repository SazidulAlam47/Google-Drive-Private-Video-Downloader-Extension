// Injected chunked download engine.
// This function must remain strictly self-contained because it is serialized
// and injected into Drive tabs via chrome.scripting.executeScript.

export function chunkedDownloadFn(url, videoTitle, requestId) {
    const CHUNK_SIZE  = 512 * 1024;
    const CONCURRENCY = 24;
    const MAX_RETRIES = 4;
    const MIN_RELIABLE_SIZE = 256 * 1024;
    const STREAMING_MAX_RETRIES = 3;

    let isPaused    = false;
    let isCancelled = false;
    let messageListener = null;
    let currentBlobUrl = null;
    let safetyRevokeTimer = null;

    const abortController = (typeof AbortController !== 'undefined')
        ? new AbortController() : null;

    const sanitizeTitle = (raw) => {
        let t = (raw || 'video')
            .replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_')
            .replace(/\s+/g, ' ')
            .replace(/^[\s.]+|[\s.]+$/g, '')
            .replace(/\.mp4$/i, '');
        if (t.length > 180) t = t.substring(0, 180);
        return t + '.mp4';
    };

    const safeTitle = sanitizeTitle(videoTitle);

    const report = (status, completedBytes, totalBytes, percent, error) => {
        try {
            chrome.runtime.sendMessage({
                type: 'downloadProgressUpdate',
                requestId: requestId,
                status: status,
                completed: completedBytes,
                total: totalBytes,
                percent: percent,
                error: error
            }, () => { void chrome.runtime.lastError; });
        } catch (e) {}
    };

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    const waitIfPaused = async () => {
        while (isPaused && !isCancelled) {
            await sleep(100);
        }
    };

    messageListener = (msg) => {
        if (!msg || msg.requestId !== requestId) return;
        if (msg.type === 'pauseDownload') {
            isPaused = true;
        } else if (msg.type === 'resumeDownload') {
            isPaused = false;
        } else if (msg.type === 'cancelDownload') {
            isCancelled = true;
            isPaused = false;
            if (abortController) {
                try { abortController.abort(); } catch (e) {}
            }
            if (currentBlobUrl) {
                try { URL.revokeObjectURL(currentBlobUrl); } catch (e) {}
                currentBlobUrl = null;
            }
            cleanup();
        } else if (msg.type === 'saveResult') {
            if (safetyRevokeTimer) {
                clearTimeout(safetyRevokeTimer);
                safetyRevokeTimer = null;
            }
            if (msg.fallbackToAnchor && currentBlobUrl) {
                // Fallback to direct anchor download when chrome.downloads cannot access blob URL
                try {
                    const a = document.createElement('a');
                    a.href = currentBlobUrl;
                    a.download = safeTitle;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                } catch (e) {}
                setTimeout(() => {
                    if (currentBlobUrl) {
                        try { URL.revokeObjectURL(currentBlobUrl); } catch (e) {}
                        currentBlobUrl = null;
                    }
                }, 60000);
            } else if (currentBlobUrl) {
                try { URL.revokeObjectURL(currentBlobUrl); } catch (e) {}
                currentBlobUrl = null;
            }
            cleanup();
        }
    };
    try {
        chrome.runtime.onMessage.addListener(messageListener);
    } catch (e) {}

    const beforeUnloadHandler = (event) => {
        event.preventDefault();
        event.returnValue = 'A video download is still in progress. Are you sure you want to leave?';
        return 'A video download is still in progress. Are you sure you want to leave?';
    };
    try {
        window.addEventListener('beforeunload', beforeUnloadHandler);
    } catch (e) {}

    const cleanup = () => {
        try {
            chrome.runtime.onMessage.removeListener(messageListener);
        } catch (e) {}
        try {
            window.removeEventListener('beforeunload', beforeUnloadHandler);
        } catch (e) {}
    };

    const handleBlobReady = (blob) => {
        try {
            currentBlobUrl = URL.createObjectURL(blob);
            // 30-minute safety timeout to prevent permanent memory leaks if worker disconnects
            safetyRevokeTimer = setTimeout(() => {
                if (currentBlobUrl) {
                    try { URL.revokeObjectURL(currentBlobUrl); } catch (e) {}
                    currentBlobUrl = null;
                }
            }, 30 * 60 * 1000);

            report('saving', blob.size, blob.size, 100, null);

            chrome.runtime.sendMessage({
                type: 'downloadBlobReady',
                requestId: requestId,
                blobUrl: currentBlobUrl,
                filename: safeTitle,
                size: blob.size
            }, () => { void chrome.runtime.lastError; });
        } catch (e) {
            report('error', blob.size, blob.size, 100, e && e.message ? e.message : String(e));
            cleanup();
        }
    };

    const isUrlExpired = (response) => {
        if (!response) return false;
        if (response.status === 403) return true;
        if (response.status === 410) return true;
        return false;
    };

    const isAbortError = (e) => {
        if (!e) return false;
        if (e.name === 'AbortError') return true;
        if (e.name === 'TimeoutError') return false;
        const msg = (e.message || '').toLowerCase();
        return msg.includes('abort') || msg.includes('signal is aborted');
    };

    const makeChunkedRequest = async (chunkUrl, start, end) => {
        const localController = (typeof AbortController !== 'undefined') ? new AbortController() : null;

        const pauseChecker = setInterval(() => {
            if (isCancelled) {
                try { localController.abort(); } catch (e) {}
            }
        }, 50);

        try {
            const response = await fetch(chunkUrl, {
                credentials: 'include',
                headers: {
                    Range: 'bytes=' + start + '-' + end,
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                },
                signal: localController ? localController.signal : undefined
            });
            return { response, controller: localController };
        } finally {
            clearInterval(pauseChecker);
        }
    };

    (async () => {
        try {
            report('starting', 0, 0, 0, null);

            if (isCancelled) {
                report('cancelled', 0, 0, 0, null);
                cleanup();
                return;
            }

            let totalSize = 0;
            let rangeSupported = false;

            try {
                const probe = await fetch(url, {
                    credentials: 'include',
                    headers: { Range: 'bytes=0-0' },
                    signal: abortController ? abortController.signal : undefined
                });

                if (isUrlExpired(probe)) {
                    report('error', 0, 0, 0, 'Video URL has expired. Reload the Drive tab to recapture a fresh URL.');
                    cleanup();
                    return;
                }

                if (probe.status === 206 || probe.ok) {
                    if (probe.status === 206) rangeSupported = true;

                    const cr = probe.headers.get('Content-Range');
                    if (cr) {
                        const m = cr.match(/\/(\d+)/);
                        if (m) {
                            totalSize = parseInt(m[1], 10);
                            rangeSupported = true;
                        }
                    }

                    if (!totalSize) {
                        const cl = probe.headers.get('Content-Length');
                        if (cl) {
                            const clNum = parseInt(cl, 10);
                            if (clNum > 1) {
                                totalSize = clNum;
                                rangeSupported = false;
                            }
                        }
                    }
                }

                try { await probe.arrayBuffer(); } catch (e) {}
            } catch (probeErr) {
                if (isCancelled) {
                    report('cancelled', 0, 0, 0, null);
                    cleanup();
                    return;
                }
            }

            if (isCancelled) {
                report('cancelled', 0, 0, 0, null);
                cleanup();
                return;
            }

            if (!totalSize || totalSize < MIN_RELIABLE_SIZE || !rangeSupported) {
                await streamingDownload();
                return;
            }

            await chunkedDownload(totalSize);
        } catch (err) {
            if (isCancelled) {
                report('cancelled', 0, 0, 0, null);
            } else {
                report('error', 0, 0, 0, err && err.message ? err.message : String(err));
            }
            cleanup();
        }
    })();

    async function streamingDownload() {
        let lastErr = null;

        for (let attempt = 1; attempt <= STREAMING_MAX_RETRIES; attempt++) {
            if (isCancelled) {
                report('cancelled', 0, 0, 0, null);
                cleanup();
                return;
            }

            let response;
            try {
                response = await fetch(url, {
                    credentials: 'include',
                    signal: abortController ? abortController.signal : undefined
                });
            } catch (e) {
                lastErr = e;
                if (isCancelled) {
                    report('cancelled', 0, 0, 0, null);
                    cleanup();
                    return;
                }
                if (attempt < STREAMING_MAX_RETRIES) {
                    await sleep(500 * attempt);
                    continue;
                }
                break;
            }

            if (isUrlExpired(response)) {
                report('error', 0, 0, 0, 'Video URL has expired. Reload the Drive tab to recapture a fresh URL.');
                cleanup();
                return;
            }

            if (!response.ok && response.status !== 206) {
                lastErr = new Error('HTTP ' + response.status);
                if (attempt < STREAMING_MAX_RETRIES) {
                    await sleep(500 * attempt);
                    continue;
                }
                break;
            }

            const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);
            const reader = response.body ? response.body.getReader() : null;
            const chunks = [];
            let received = 0;

            if (!reader) {
                try {
                    const blob = await response.blob();
                    handleBlobReady(blob);
                } catch (e) {
                    report('error', 0, 0, 0, e && e.message ? e.message : String(e));
                    cleanup();
                }
                return;
            }

            try {
                while (true) {
                    if (isCancelled) {
                        try { reader.cancel(); } catch (e) {}
                        report('cancelled', received, contentLength, 0, null);
                        cleanup();
                        return;
                    }
                    if (isPaused) {
                        report('paused', received, contentLength,
                               contentLength > 0 ? Math.round((received / contentLength) * 100) : 0, null);
                        await waitIfPaused();
                        if (isCancelled) {
                            try { reader.cancel(); } catch (e) {}
                            report('cancelled', received, contentLength, 0, null);
                            cleanup();
                            return;
                        }
                        report('downloading', received, contentLength,
                               contentLength > 0 ? Math.round((received / contentLength) * 100) : 0, null);
                    }

                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                    received += value.byteLength;

                    const percent = contentLength > 0
                        ? Math.min(100, Math.round((received / contentLength) * 100))
                        : 0;
                    report('downloading', received, contentLength, percent, null);
                }

                const blob = new Blob(chunks, { type: 'video/mp4' });
                handleBlobReady(blob);
                return;
            } catch (e) {
                if (isCancelled) {
                    report('cancelled', received, contentLength, 0, null);
                    cleanup();
                    return;
                }
                if (isPaused) {
                    await waitIfPaused();
                    if (isCancelled) {
                        report('cancelled', received, contentLength, 0, null);
                        cleanup();
                        return;
                    }
                    report('downloading', received, contentLength,
                           contentLength > 0 ? Math.round((received / contentLength) * 100) : 0, null);
                    continue;
                }
                if (isAbortError(e) && !isCancelled) {
                    continue;
                }
                lastErr = e;
                if (attempt < STREAMING_MAX_RETRIES) {
                    await sleep(500 * attempt);
                    continue;
                }
                report('error', received, contentLength, 0,
                       e && e.message ? e.message : String(e));
                cleanup();
                return;
            }
        }

        if (lastErr) {
            if (isCancelled) {
                report('cancelled', 0, 0, 0, null);
            } else {
                report('error', 0, 0, 0, lastErr && lastErr.message ? lastErr.message : String(lastErr));
            }
        }
        cleanup();
    }

    async function chunkedDownload(totalSize) {
        const ranges = [];
        for (let start = 0; start < totalSize; start += CHUNK_SIZE) {
            const end = Math.min(start + CHUNK_SIZE - 1, totalSize - 1);
            ranges.push({ start: start, end: end });
        }

        report('downloading', 0, totalSize, 0, null);

        const chunks = new Array(ranges.length);
        let nextIndex = 0;
        let bytesDownloaded = 0;
        let lastReportTime = 0;

        async function worker() {
            while (true) {
                if (isCancelled) return;

                if (isPaused) {
                    await waitIfPaused();
                    if (isCancelled) return;
                }

                const index = nextIndex++;
                if (index >= ranges.length) return;

                const { start, end } = ranges[index];
                let chunkComplete = false;
                let rangeIgnored = false;

                for (let attempt = 1; attempt <= MAX_RETRIES && !chunkComplete; attempt++) {
                    if (isCancelled) return;
                    if (isPaused) {
                        await waitIfPaused();
                        if (isCancelled) return;
                    }

                    let response = null;
                    try {
                        const chunkUrl = url + (url.indexOf('?') >= 0 ? '&' : '?') +
                            'rn=' + index + '.' + attempt + '.' + Date.now();

                        const result = await makeChunkedRequest(chunkUrl, start, end);
                        response = result.response;

                        if (response.status === 200 && response.headers.get('Content-Range')) {
                            rangeIgnored = true;
                            break;
                        }
                        if (response.ok || response.status === 206) {
                            if (isUrlExpired(response)) {
                                report('error', bytesDownloaded, totalSize,
                                       Math.round((bytesDownloaded / totalSize) * 100),
                                       'Video URL has expired. Reload the Drive tab to recapture a fresh URL.');
                                cleanup();
                                return;
                            }
                        } else {
                            if (isUrlExpired(response)) {
                                report('error', bytesDownloaded, totalSize,
                                       Math.round((bytesDownloaded / totalSize) * 100),
                                       'Video URL has expired. Reload the Drive tab to recapture a fresh URL.');
                                cleanup();
                                return;
                            }
                            response = null;
                        }
                    } catch (e) {
                        if (isCancelled) return;
                        if (isPaused) {
                            await waitIfPaused();
                            if (isCancelled) return;
                            attempt--;
                            continue;
                        }
                        if (isAbortError(e) && !isCancelled) {
                            attempt--;
                            continue;
                        }
                        response = null;
                    }

                    if (rangeIgnored) break;

                    if (!response) {
                        if (attempt < MAX_RETRIES) {
                            const waitMs = 200 * attempt;
                            const steps = Math.max(1, Math.floor(waitMs / 50));
                            for (let i = 0; i < steps; i++) {
                                if (isCancelled) return;
                                if (isPaused) break;
                                await sleep(50);
                            }
                            continue;
                        }
                        throw new Error('Chunk ' + (index + 1) + ' failed after ' + MAX_RETRIES + ' retries');
                    }

                    let data;
                    try {
                        data = await response.arrayBuffer();
                    } catch (e) {
                        if (isCancelled) return;
                        if (isPaused) {
                            await waitIfPaused();
                            if (isCancelled) return;
                            attempt--;
                            continue;
                        }
                        if (isAbortError(e) && !isCancelled) {
                            attempt--;
                            continue;
                        }
                        if (attempt < MAX_RETRIES) {
                            const waitMs = 200 * attempt;
                            const steps = Math.max(1, Math.floor(waitMs / 50));
                            for (let i = 0; i < steps; i++) {
                                if (isCancelled) return;
                                await sleep(50);
                            }
                            continue;
                        }
                        throw e;
                    }

                    if (isCancelled) return;

                    const expected = end - start + 1;
                    if (data.byteLength < expected) {
                        if (attempt < MAX_RETRIES) {
                            await sleep(200 * attempt);
                            continue;
                        }
                        throw new Error('Chunk ' + (index + 1) + ' short read: ' + data.byteLength + '/' + expected);
                    }
                    chunks[index] = (data.byteLength > expected) ? data.slice(0, expected) : data;
                    bytesDownloaded += chunks[index].byteLength;
                    chunkComplete = true;

                    const now = Date.now();
                    if (now - lastReportTime > 100 || bytesDownloaded >= totalSize) {
                        lastReportTime = now;
                        const percent = Math.min(100, Math.round((bytesDownloaded / totalSize) * 100));
                        report('downloading', bytesDownloaded, totalSize, percent, null);
                    }
                }

                if (isCancelled) return;
                if (rangeIgnored) {
                    throw new Error('Server ignored Range header. Cannot safely download in chunks. Try again or use a different video.');
                }
                if (!chunkComplete) {
                    throw new Error('Chunk ' + (index + 1) + ' failed after ' + MAX_RETRIES + ' retries');
                }
            }
        }

        try {
            await Promise.all(
                Array.from(
                    { length: Math.min(CONCURRENCY, ranges.length) },
                    () => worker()
                )
            );

            if (isCancelled) {
                report('cancelled', bytesDownloaded, totalSize,
                       Math.round((bytesDownloaded / totalSize) * 100), null);
                cleanup();
                return;
            }

            const blob = new Blob(chunks, { type: 'video/mp4' });
            if (blob.size !== totalSize) {
                throw new Error('Final size mismatch: ' + blob.size + '/' + totalSize);
            }

            handleBlobReady(blob);
        } catch (err) {
            if (isCancelled) {
                report('cancelled', bytesDownloaded, totalSize,
                       Math.round((bytesDownloaded / totalSize) * 100), null);
            } else {
                report('error', bytesDownloaded, totalSize,
                       Math.round((bytesDownloaded / totalSize) * 100),
                       err && err.message ? err.message : String(err));
            }
            cleanup();
        } finally {
            if (!currentBlobUrl) {
                cleanup();
            }
        }
    }
}

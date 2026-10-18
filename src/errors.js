// Error codes and user-facing messages

export const ERROR_CODES = {
    NO_DRIVE_VIDEO_PAGE: 'NO_DRIVE_VIDEO_PAGE',
    NOT_A_DRIVE_FOLDER: 'NOT_A_DRIVE_FOLDER',
    NO_VIDEOS_IN_FOLDER: 'NO_VIDEOS_IN_FOLDER',
    NO_MEDIA_REQUEST_CAPTURED: 'NO_MEDIA_REQUEST_CAPTURED',
    DESTINATION_CANCELLED: 'DESTINATION_CANCELLED',
    DOWNLOAD_INTERRUPTED: 'DOWNLOAD_INTERRUPTED',
    DOWNLOAD_INIT_FAILED: 'DOWNLOAD_INIT_FAILED',
    DESTINATION_NOT_APPLIED: 'DESTINATION_NOT_APPLIED',
    CAPTURE_TIMEOUT: 'CAPTURE_TIMEOUT',
    URL_EXPIRED: 'URL_EXPIRED',
    ATTACH_FAILED: 'ATTACH_FAILED',
    DEBUGGER_DETACHED: 'DEBUGGER_DETACHED',
    TAB_CLOSED: 'TAB_CLOSED',
    MAX_CONCURRENT_REACHED: 'MAX_CONCURRENT_REACHED',
    ALREADY_IN_PROGRESS: 'ALREADY_IN_PROGRESS',
    CAPTURE_NOT_AVAILABLE: 'CAPTURE_NOT_AVAILABLE',
    QUEUE_PAUSED: 'QUEUE_PAUSED',
    QUEUE_STOPPED: 'QUEUE_STOPPED',
    NETWORK_ERROR_RETRYABLE: 'NETWORK_ERROR_RETRYABLE',
    DOWNLOAD_FAILED_NON_RETRYABLE: 'DOWNLOAD_FAILED_NON_RETRYABLE',
    SCAN_STALE_OR_TAB_CLOSED: 'SCAN_STALE_OR_TAB_CLOSED',
    NO_VIDEOS_SELECTED: 'NO_VIDEOS_SELECTED',
    DESTINATION_NOT_CONFIGURED: 'DESTINATION_NOT_CONFIGURED',
    BULK_REQUIRES_SUBFOLDER: 'BULK_REQUIRES_SUBFOLDER',
    QUEUE_BUSY: 'QUEUE_BUSY'
};

export const ERROR_MESSAGES = {
    [ERROR_CODES.NO_DRIVE_VIDEO_PAGE]: 'No Google Drive video page detected. Open a video preview page (e.g. drive.google.com/file/d/...) and try again.',
    [ERROR_CODES.NOT_A_DRIVE_FOLDER]: 'No Google Drive folder detected. Open a folder page (e.g. drive.google.com/drive/folders/...) and try again.',
    [ERROR_CODES.NO_VIDEOS_IN_FOLDER]: 'No video files found in the selected folder.',
    [ERROR_CODES.NO_VIDEOS_SELECTED]: 'Select at least one video to download.',
    [ERROR_CODES.DESTINATION_NOT_CONFIGURED]: 'Save destination is not configured. Please set your destination folder.',
    [ERROR_CODES.BULK_REQUIRES_SUBFOLDER]: 'Bulk download requires a subfolder save destination (interactive prompt is not supported for bulk).',
    [ERROR_CODES.QUEUE_BUSY]: 'A bulk download is currently in progress. Please wait or stop the current queue before starting a new one.',
    [ERROR_CODES.NO_MEDIA_REQUEST_CAPTURED]: 'No media stream request captured for this video. Play the video or click Reload below.',
    [ERROR_CODES.DESTINATION_CANCELLED]: 'Destination folder selection was cancelled. Download aborted.',
    [ERROR_CODES.DOWNLOAD_INTERRUPTED]: 'Download was interrupted. Click Retry to restart.',
    [ERROR_CODES.DOWNLOAD_INIT_FAILED]: 'Failed to initiate download via Chrome download manager.',
    [ERROR_CODES.DESTINATION_NOT_APPLIED]: 'Saved to default Downloads folder (custom folder not applied).',
    [ERROR_CODES.CAPTURE_TIMEOUT]: 'Capture timed out while waiting for media playback requests.',
    [ERROR_CODES.URL_EXPIRED]: 'Video stream URL has expired. Tab recapture required.',
    [ERROR_CODES.ATTACH_FAILED]: 'Debugger attachment failed. Verify tab permissions and that DevTools is not attached.',
    [ERROR_CODES.DEBUGGER_DETACHED]: 'Debugger was detached (infobar dismissed or tab closed).',
    [ERROR_CODES.TAB_CLOSED]: 'The tab was closed during capture or download.',
    [ERROR_CODES.MAX_CONCURRENT_REACHED]: 'Maximum 3 concurrent downloads reached. Please wait for one to finish.',
    [ERROR_CODES.ALREADY_IN_PROGRESS]: 'Download is already in progress for this video.',
    [ERROR_CODES.CAPTURE_NOT_AVAILABLE]: 'Capture is not available on this page.',
    [ERROR_CODES.QUEUE_PAUSED]: 'Bulk download queue is paused.',
    [ERROR_CODES.QUEUE_STOPPED]: 'Bulk download queue was stopped by user.',
    [ERROR_CODES.NETWORK_ERROR_RETRYABLE]: 'Network error or chunk failure. Will retry download.',
    [ERROR_CODES.DOWNLOAD_FAILED_NON_RETRYABLE]: 'Download failed with a non-recoverable server error.',
    [ERROR_CODES.SCAN_STALE_OR_TAB_CLOSED]: 'Folder scan is stale or tab was closed. Please re-scan folder.'
};

export function classifyEngineError(text) {
    if (!text) return 'DOWNLOAD_FAILED';
    const lower = String(text).toLowerCase();
    if (lower.includes('expired') || lower.includes('403') || lower.includes('forbidden') || lower.includes('url expired')) {
        return ERROR_CODES.URL_EXPIRED;
    }
    if (
        lower.includes('failed after') ||
        lower.includes('retry') ||
        lower.includes('retries') ||
        lower.includes('network') ||
        lower.includes('short read') ||
        lower.includes('timeout') ||
        lower.includes('fetch failed')
    ) {
        return ERROR_CODES.NETWORK_ERROR_RETRYABLE;
    }
    if (
        lower.includes('range') ||
        lower.includes('server ignored range') ||
        lower.includes('404') ||
        lower.includes('not found') ||
        lower.includes('401') ||
        lower.includes('unauthorized')
    ) {
        return ERROR_CODES.DOWNLOAD_FAILED_NON_RETRYABLE;
    }
    return 'DOWNLOAD_FAILED';
}

export function getErrorMessage(code, fallback = 'An unexpected error occurred.') {
    if (!code) return fallback;
    return ERROR_MESSAGES[code] || fallback || code;
}

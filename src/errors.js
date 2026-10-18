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
    QUEUE_STOPPED: 'QUEUE_STOPPED'
};

export const ERROR_MESSAGES = {
    [ERROR_CODES.NO_DRIVE_VIDEO_PAGE]: 'No Google Drive video page detected. Open a video preview page (e.g. drive.google.com/file/d/...) and try again.',
    [ERROR_CODES.NOT_A_DRIVE_FOLDER]: 'No Google Drive folder detected. Open a folder page (e.g. drive.google.com/drive/folders/...) and try again.',
    [ERROR_CODES.NO_VIDEOS_IN_FOLDER]: 'No video files found in the selected folder.',
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
    [ERROR_CODES.QUEUE_STOPPED]: 'Bulk download queue was stopped by user.'
};

export function getErrorMessage(code, fallback = 'An unexpected error occurred.') {
    if (!code) return fallback;
    return ERROR_MESSAGES[code] || fallback || code;
}

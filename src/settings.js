// Settings management and path / title sanitization pure functions

export const DEFAULT_SUBFOLDER = 'Drive Videos';

export const DEFAULT_DESTINATION = {
    mode: 'subfolder',
    subfolder: DEFAULT_SUBFOLDER,
    configured: false
};

/**
 * Sanitizes a video title into a safe filename ending with .mp4
 */
export function sanitizeTitle(rawTitle) {
    let t = (rawTitle || 'video')
        .replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/^[\s.]+|[\s.]+$/g, '')
        .replace(/\.mp4$/i, '')
        .trim();

    if (!t) t = 'video';
    if (t.length > 180) t = t.substring(0, 180).trim();

    return t + '.mp4';
}

/**
 * Sanitizes a subfolder path:
 * - strips drive letters, absolute slashes, and illegal chars
 * - collapses and removes relative parent segments (..)
 * - supports nested folders like "Course/Module 1"
 * - returns DEFAULT_SUBFOLDER if the result is empty or invalid
 */
export function sanitizeSubfolder(rawSubfolder, fallback = DEFAULT_SUBFOLDER) {
    if (!rawSubfolder || typeof rawSubfolder !== 'string') {
        return fallback;
    }

    let input = rawSubfolder.trim();

    // Strip leading drive letters (e.g. C:)
    input = input.replace(/^[a-zA-Z]:/, '');

    // Normalize backslashes to forward slashes
    input = input.replace(/\\+/g, '/');

    // Split into segments and sanitize each
    const rawSegments = input.split('/');
    const safeSegments = [];

    for (const rawSeg of rawSegments) {
        let seg = rawSeg.trim();

        // Strip leading/trailing dots and spaces
        seg = seg.replace(/^[\s.]+|[\s.]+$/g, '');

        // Replace illegal filesystem characters & control characters
        seg = seg.replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_');
        seg = seg.replace(/\s+/g, ' ');
        seg = seg.trim();

        // Discard empty segments or traversal segments
        if (!seg || seg === '.' || seg === '..') {
            continue;
        }

        if (seg.length > 80) {
            seg = seg.substring(0, 80).trim();
        }

        safeSegments.push(seg);
    }

    if (safeSegments.length === 0) {
        return fallback;
    }

    let result = safeSegments.join('/');
    if (result.length > 200) {
        result = result.substring(0, 200).replace(/\/+$/, '');
    }

    return result || fallback;
}

/**
 * Builds the download options (filename and saveAs flag) for chrome.downloads.download
 */
export function buildDownloadPath(destination, rawTitle) {
    const safeTitle = sanitizeTitle(rawTitle);
    const dest = destination || DEFAULT_DESTINATION;

    if (dest.mode === 'askEachTime') {
        return {
            filename: safeTitle,
            saveAs: true,
            subfolder: ''
        };
    }

    const subfolder = sanitizeSubfolder(dest.subfolder, DEFAULT_SUBFOLDER);
    return {
        filename: `${subfolder}/${safeTitle}`,
        saveAs: false,
        subfolder: subfolder
    };
}

/**
 * Validates destination configuration
 */
export function validateDestination(destination, isBulk = false) {
    if (!destination || destination.configured === false) {
        return { valid: false, error: 'DESTINATION_NOT_CONFIGURED', needsDialog: true };
    }

    if (isBulk && destination.mode === 'askEachTime') {
        return { valid: false, error: 'BULK_REQUIRES_SUBFOLDER', needsDialog: true };
    }

    return { valid: true };
}

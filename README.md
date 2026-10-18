# Drive Private Video Downloader (v3.0)

A powerful Manifest V3 Chrome extension designed to download private and shared videos directly from Google Drive. It works by capturing the authenticated media streams used by the Google Drive video player and downloading the video using chunked parallel transfers.

---

## What's New in Version 3.0

Version 3.0 is a comprehensive architectural upgrade introducing:

* **Chrome Side Panel UI**: The legacy popup has been replaced with a native Chrome Side Panel (`sidepanel.html`). It remains open and active while you browse, switch tabs, or interact with Google Drive.
* **Streamlined Single Download**: Downloads video directly from the current tab. Zero tab reloading, zero duplicate tab creation, and non-intrusive muted playback nudging to safely capture media streams.
* **Bulk Folder Download**: Scan entire Google Drive folders—even large folders with hundreds of items—using an automated scroll-settle virtualization scanner. Download all discovered videos sequentially with automatic background tab management.
* **Queue Lifecycle & Watchdogs**: Robust 45-second stream capture watchdog, 120-second download stall watchdog, automatic retry for transient failures, pause/resume/stop controls, and crash recovery across service worker restarts.
* **Configurable Download Destination**: Save files into organized subfolders within your browser's default Downloads directory or prompt with a native Save-As dialog (Single Download).
* **Accurate Completion Tracking**: Leverages `chrome.downloads.onChanged` to ensure the extension reports completion only after the file has been fully committed to disk.

---

## Features

* **Private & Shared Video Support**: Works with any Google Drive video you have legitimate view permissions for.
* **Zero-Reload Single Download**: Download without reloading your tab or losing your playback position.
* **Bulk Folder Scanning & Sequential Queue**:
  * Automatically scans virtualized Drive folder item lists.
  * Processes videos strictly one by one in isolated background tabs.
  * Pause, resume, or safely stop queues at any time without closing the source folder tab.
* **Intelligent Watchdogs & Retries**:
  * 45s capture timeout; 120s progress stall watchdog.
  * Up to 2 retries on transient network or capture failures before safely moving to the next item.
* **Fast Chunked Downloader**: Injects a 24-worker, 512 KiB chunked downloader with per-chunk retries and streaming fallback.
* **Safe Filesystem Sanitization**: Automatically scrubs illegal filename characters, path traversal sequences (`..`), and Windows reserved names.

---

## Installation

1. Clone or download this repository.
2. Open Google Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** using the toggle in the upper right corner.
4. Click **Load unpacked** in the top left.
5. Select the `Google-Drive-Private-Video-Downloader-Extension` directory.
6. Click the extension icon in your Chrome toolbar to open the Side Panel.

---

## How It Works

```
sidepanel.html/.js/.css  <--- messages + storage.onChanged --->  background.js (Service Worker)
                                                                    |-- Capture Manager (debugger)
                                                                    |-- Destination Settings
                                                                    |-- Single Download Controller
                                                                    |-- Bulk Queue Controller
                                                                    '-- Download Tracker (chrome.downloads)
                                                                    |
                                     chrome.scripting.executeScript --> Drive Tab (User or Owned Tab)
                                                                        chunkedDownloadFn (24 parallel workers)
```

1. **Stream Capture**: When enabled, the extension attaches to the Drive tab using Chrome's Debugger API to monitor `Network.responseReceived` events from `workspacevideo-pa.clients6.google.com`. It parses the video's streaming metadata, title, and highest bitrate progressive stream URL.
2. **Download Execution**: The background worker injects `chunkedDownloadFn` into the Drive tab's isolated world, allowing it to fetch chunks using the user's active session and cookies.
3. **File Writing**: The assembled blob URL is passed to `chrome.downloads.download()`, which handles disk writing and respects the configured subfolder.

---

## Permissions Rationale

This extension uses a minimal and deliberate set of permissions:

| Permission | Purpose |
| :--- | :--- |
| **`sidePanel`** | Required to display the side panel interface (`sidepanel.html`) next to web pages. |
| **`debugger`** | Required to attach Chrome DevTools Protocol to inspect network responses and capture authenticated video stream URLs. |
| **`downloads`** | Required to programmatically initiate downloads and track true completion status on disk via `chrome.downloads.onChanged`. |
| **`storage`** | Required to persist user settings (download folder, queue state, progress) across sessions and service worker lifecycles. |
| **`scripting`** | Required to inject chunked download workers and non-intrusive playback nudge scripts into Google Drive tabs. |
| **`https://drive.google.com/*`** | Host permission required to inspect and inject scripts into Google Drive tabs. |

> [!NOTE]
> **Deliberate Omission of the `tabs` Permission**:
> The high-privilege `tabs` permission is intentionally **not** requested. All tab operations (`chrome.tabs.create`, `update`, `remove`, `query`, `onActivated`, `onRemoved`) work without it. Tab URLs are accessible on `drive.google.com` via host permissions.

---

## Download Destination & Browser Sandbox Limits

Chrome's extension security model restricts file writes:
- **No arbitrary filesystem access**: Chrome extensions cannot silently write files to arbitrary absolute disk paths outside Chrome's default Downloads directory.
- **Subfolder Mode**: Files are saved into `Downloads/<subfolder>/<filename>.mp4`. The subfolder path is strictly sanitized to prevent directory traversal (`..`) or invalid path characters.
- **Save-As Dialog**: Available for Single Downloads, this prompts you with the browser's native file picker before saving.

---

## Known Limitations

1. **Drive Web Player DOM Selectors**: Folder scanning and playback nudge functions rely on Google Drive web client DOM structures (e.g., `role="row"`, `role="gridcell"`, `div[aria-label="Play"]`). If Google alters Drive's DOM layout, updated selectors may be required.
2. **In-Memory Blob Assembly**: The chunked download engine constructs an in-memory `Blob` before passing it to Chrome's download manager. Downloading exceptionally large files (>2–4 GB) may experience high memory consumption in the tab.

---

## Authors & Credits

* **Original Author**: [Md. Abdullah Al Maruf](https://github.com/md-abdullah-al-maruf) (v1.0 / v2.0)
* **Modified & Enhanced by**: [Sazidul Alam](https://github.com/SazidulAlam47) (v3.0)

---

## License

This project is licensed under the [MIT License](LICENSE).

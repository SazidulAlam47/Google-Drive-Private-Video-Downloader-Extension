# Manual Browser Testing Checklist (v3.0)

This document contains the step-by-step verification checklist for manual testing in a live Google Chrome browser.

> [!NOTE]
> All automated Node tests (`node --test`) and syntax checks have passed. As per project constraints, tests requiring a live browser and active Google Drive session are listed below for user verification and marked as **`[NOT RUN - Manual Browser Test Required]`**.

---

### Test Cases

#### 1. Side Panel Opening
* **Status**: `[NOT RUN - Manual Browser Test Required]`
* **Procedure**:
  1. Open Chrome with the extension loaded unpacked.
  2. Click the extension toolbar icon.
  3. Verify that the Chrome Side Panel opens on the side of the browser (instead of a floating popup).
  4. Switch to different tabs or resize the window; verify that the Side Panel remains docked and open.

---

#### 2. ON / OFF State Toggle & Detach
* **Status**: `[NOT RUN - Manual Browser Test Required]`
* **Procedure**:
  1. Navigate to a Google Drive video preview tab.
  2. In the Side Panel, verify that the state is **OFF**.
  3. Click **ON**. Verify that the status dot turns green, active tab is recognized as a Drive Video page, and the debugger bar (`"Drive Private Video Downloader started debugging this browser"`) appears on the tab.
  4. Click **OFF**.
  5. Verify that the debugger banner disappears immediately and the tab is **NOT** reloaded.
  6. Switch to a non-Drive tab (e.g. `chrome://extensions`); click **OFF**; verify no errors occur.

---

#### 3. Single Download (Zero Tab Reload / Zero New Tabs)
* **Status**: `[NOT RUN - Manual Browser Test Required]`
* **Procedure**:
  1. Open a Google Drive video page where the user has view/preview access.
  2. Start playback or seek slightly.
  3. Click **⚡ Single Download** in the Side Panel.
  4. Verify:
     - No new browser tabs or windows are created.
     - The current Drive video tab is **never** reloaded automatically.
     - Progress bar in the Side Panel updates continuously as chunks are downloaded.
     - Once download completes, the video is saved to disk and marked completed.

---

#### 4. Destination Configuration (Subfolder vs Ask Each Time)
* **Status**: `[NOT RUN - Manual Browser Test Required]`
* **Procedure**:
  1. In the Side Panel, click **Change** next to "Save to".
  2. Select **Subfolder in Downloads** and type `Drive Videos/TestBatch`. Click **Confirm**.
  3. Trigger a download; verify the file appears in `<Downloads>/Drive Videos/TestBatch/<filename>.mp4`.
  4. Open destination modal again, select **Ask each time (Save-As dialog)**. Click **Confirm**.
  5. Start a Single Download; verify Chrome displays the native OS Save-As file dialog.
  6. Attempt to start a Bulk Download; verify the UI informs you that bulk download requires subfolder mode.

---

#### 5. True Download Completion Tracking (`chrome.downloads`)
* **Status**: `[NOT RUN - Manual Browser Test Required]`
* **Procedure**:
  1. Start a video download.
  2. Observe the progress reaching 100% and entering the `saving` state.
  3. Open Chrome's Download shelf or `chrome://downloads`.
  4. Confirm that the Side Panel only marks the download as **Completed** after Chrome finishes writing the file to disk (not when the blob is created).

---

#### 6. Bulk Folder Scan (Virtualization & Settling on 200+ Items)
* **Status**: `[NOT RUN - Manual Browser Test Required]`
* **Procedure**:
  1. Navigate to a Google Drive folder containing a large number of files (>200 items, mix of videos, folders, documents).
  2. In the Side Panel, verify the chip displays `FOLDER` and **📁 Bulk Download Folder** is enabled.
  3. Click **📁 Bulk Download Folder**.
  4. Verify that the scanner automatically scrolls the virtualized file list, waits for items to settle, returns to the original scroll position, and displays a summary dialog showing:
     - Total items scanned
     - Videos detected
     - Folders skipped
     - Other file types skipped

---

#### 7. Bulk Sequential Queue Execution (>= 3 Videos)
* **Status**: `[NOT RUN - Manual Browser Test Required]`
* **Procedure**:
  1. On a folder containing at least 3 videos, click **Start Download** from the scan report modal.
  2. Verify:
     - The Bulk Queue panel appears showing `0 / N` completed.
     - Exactly one background tab (`active: false`) is opened for the active video.
     - The active tab begins capture, then downloads.
     - When finished, the background tab is closed and the next video begins automatically.
     - The user's original folder tab is **never closed or reloaded**.

---

#### 8. Bulk Pause and Resume Mid-Download
* **Status**: `[NOT RUN - Manual Browser Test Required]`
* **Procedure**:
  1. During an active bulk download queue, click **⏸ Pause**.
  2. Verify that the queue status changes to `Pausing` / `Paused`.
  3. Verify that once the current item pauses or completes, no new tabs are opened.
  4. Click **▶ Resume**.
  5. Verify the queue resumes downloading the remaining videos smoothly.

---

#### 9. Bulk Stop Confirmation and Safe Tab Teardown
* **Status**: `[NOT RUN - Manual Browser Test Required]`
* **Procedure**:
  1. While a bulk queue is running, click **⏹ Stop**.
  2. Verify a confirmation modal appears asking to confirm stopping.
  3. Click **Yes, Stop**.
  4. Verify:
     - The background video tab owned by the queue is immediately closed.
     - The queue enters `stopped` status.
     - The source folder tab remains open and unaffected.

---

#### 10. Background Tab Closure Resilience (Retry & Advance)
* **Status**: `[NOT RUN - Manual Browser Test Required]`
* **Procedure**:
  1. Start a bulk download queue.
  2. While a video is actively capturing or downloading in the background tab, manually close that background tab using Chrome's tab bar.
  3. Verify:
     - The extension catches the tab closure without crashing.
     - It retries the video in a fresh background tab (up to 2 retry attempts).
     - If it still fails, it marks that item as failed and advances to the next video in the queue.

---

#### 11. Tab Switching & Window Management Invariance
* **Status**: `[NOT RUN - Manual Browser Test Required]`
* **Procedure**:
  1. While a single download or bulk download queue is running, switch between various tabs, open new tabs, and move windows around.
  2. Verify that progress continues unimpeded and no state or tab ID confusion occurs.

---

#### 12. Service Worker Termination Mid-Queue (Recovery as Paused)
* **Status**: `[NOT RUN - Manual Browser Test Required]`
* **Procedure**:
  1. Start a bulk download queue.
  2. Open `chrome://extensions` in a separate tab, find Drive Private Video Downloader, and click **Service worker (inactive)** or inspect background page and trigger worker stop / restart.
  3. Return to the Side Panel.
  4. Verify:
     - The queue state is safely restored as `paused`.
     - An informative banner is shown: *"The extension restarted. Resume to continue."*
     - Clicking **Resume** continues the queue from the pending item without duplicate downloads.

---

#### 13. Large Video Memory Sanity (> 2 GB)
* **Status**: `[NOT RUN - Manual Browser Test Required]`
* **Procedure**:
  1. Attempt downloading a large video file (>2 GB).
  2. Monitor Chrome Task Manager (`Shift + Esc`) for the video tab's memory usage.
  3. Verify whether the browser successfully allocates the in-memory Blob and writes to disk.

---

#### 14. Forced Fallback Save Path (Blob handoff rejection)
* **Status**: `[NOT RUN - Manual Browser Test Required]`
* **Procedure**:
  1. Trigger or simulate a rejection by `chrome.downloads.download` (e.g. test on a Chrome build where blob URLs from isolated script execution are restricted or pass an invalid reserved device path).
  2. Verify:
     - The extension catches the rejection without hanging.
     - The item falls back to in-tab anchor save and lands in Chrome's default Downloads folder.
     - The queue marks the item `completed` with note: `"Saved to default Downloads folder (custom folder not applied)"`.
     - `state.blobHandoffUnsupported` is set and persistent banner is shown in the side panel.
     - Subsequent items in the queue skip `chrome.downloads` and proceed directly via anchor save without retrying or hanging.
     - No duplicate downloads occur.

---

#### 15. Real Engine Error Mid-Bulk (Revoked access / Expired URL)
* **Status**: `[NOT RUN - Manual Browser Test Required]`
* **Procedure**:
  1. Start a bulk download on a folder with >= 2 videos.
  2. While the first video is downloading, revoke file access or simulate expired media stream token.
  3. Verify:
     - The engine sends an error with the expired token message.
     - The queue catches the error immediately without waiting for the 120s stall watchdog.
     - The item attempts a fresh tab retry (attempt 2).
     - If failure persists, it marks the item as `failed` with the real error message displayed in the UI.
     - The queue advances to video 2 without blocking.

---

#### 16. Pause Then Resume Race
* **Status**: `[NOT RUN - Manual Browser Test Required]`
* **Procedure**:
  1. Start a bulk queue download.
  2. While a video is actively downloading (around 30%), click **⏸ Pause**.
  3. Observe that late progress messages do not flip the state back to `downloading`.
  4. Wait 5 seconds, then click **▶ Resume**.
  5. Verify:
     - The queue resumes the active video smoothly (sends `resumeDownload`).
     - It does NOT advance to or skip the current video.
     - Download finishes at 100% and advances to the next item in sequence.

---

#### 17. History Preservation After Tab Closures
* **Status**: `[NOT RUN - Manual Browser Test Required]`
* **Procedure**:
  1. Download a video via Single Download or Bulk Download until completed.
  2. Close the background video tab (or user's video tab).
  3. Verify:
     - The completed video remains visible in the Side Panel history list.
     - It is NOT removed when `chrome.tabs.onRemoved` fires.
     - Click **Clear History**; verify completed historical items are cleared while any active downloading items remain preserved.

---

#### 18. Bulk History Clearing & Dismissal (Bug 1 Verification)
* **Status**: `[NOT RUN - Manual Browser Test Required]`
* **Procedure**:
  1. Run a bulk download on a folder with multiple videos until completed or stopped.
  2. Verify items appear in the history list and the bulk summary panel shows `N / N · x failed`.
  3. Click **Clear History**; verify:
     - All terminal history records (`completed`, `failed`, `cancelled`, `interrupted`) are cleared from the list.
     - Transient `queued` entries are not left orphaned.
     - The bulk summary panel is reset and hidden.
  4. In a new bulk run that finishes, verify the Dismiss button (`×`) appears in the bulk header.
  5. Click `×`; verify the bulk summary panel is dismissed without wiping non-bulk history records.

---

#### 19. Stop Button Lifecycle & Stopped State Distinction (Bug 2 Verification)
* **Status**: `[NOT RUN - Manual Browser Test Required]`
* **Procedure**:
  1. Run a bulk folder download and let all items finish downloading.
  2. Verify that when state reaches `finished`:
     - The **Stop** and **Pause/Resume** buttons are hidden/disabled.
     - The Dismiss button (`×`) is visible.
     - No stray clicks can trigger the stop confirmation modal or `bulkStop` message.
  3. In another run with multiple videos, click **⏹ Stop** and confirm:
     - The queue transitions to `stopped` state (red badge) rather than `finished`.
     - Pending and active videos are recorded as `cancelled` in queue and history.
     - Owned background tabs are closed.
     - Further stop calls are guarded and ignored.

---

#### 20. Video Selection Modal & Checkbox Filtering
* **Status**: `[NOT RUN - Manual Browser Test Required]`
* **Procedure**:
  1. Open a Google Drive folder containing 10+ videos (including videos with non-Latin/Bengali names).
  2. Click **Bulk Download Folder**.
  3. Verify:
     - The selection modal appears showing the names of all found videos.
     - All checkboxes are checked by default.
     - Summary counter displays `Found N videos · N selected`.
     - Bengali and non-Latin video names render correctly (`dir="auto"`).
     - Each row displays an index number (`1.`, `2.`, ...).
  4. Uncheck 3 videos:
     - Verify the summary counter updates live to `Found N videos · (N - 3) selected`.
     - Verify the Start button updates to `Start Download (N - 3)`.
  5. Click **Deselect All**:
     - Verify all checkboxes are unchecked in one pass.
     - Verify Start button is disabled (`Start Download (0)`) and hint `"Select at least one video"` is shown.
     - Verify **Deselect All** button is disabled, **Select All** button is enabled.
  6. Click **Select All**:
     - Verify all checkboxes are re-checked in one pass.
     - Verify Start button is re-enabled (`Start Download (N)`).
     - Verify **Select All** button is disabled, **Deselect All** button is enabled.
  7. Click **Cancel**:
     - Verify the selection modal closes without initiating any downloads.
  8. Click **Bulk Download Folder** again, uncheck 3 videos, and click **Start Download (N - 3)**:
     - Verify the selection modal closes.
     - Verify the bulk queue initializes with exactly the N - 3 selected videos in their original scan order.
     - Verify the 3 unchecked videos are never opened in background tabs, captured, or downloaded.
  9. Test on a large folder with 200+ videos:
     - Verify the selection list scrolls smoothly and remains responsive (`content-visibility: auto`).
  10. Stale scan verification:
     - Perform a scan, wait > 10 minutes (or close the Drive folder tab), then trigger bulk download.
     - Verify the error `"Folder scan is stale or tab was closed. Please re-scan folder."` appears in the persistent error area.
  11. Panel closure test:
     - Scan a folder, change selection, close the side panel before clicking Start.
     - Verify nothing starts and no stray tabs are created.


# Res-Find

> Sniff images, videos, HLS/DASH streams, and audio resources from any web page -- download with one click.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-brightgreen?logo=googlechrome)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
![License](https://img.shields.io/badge/License-MIT-green)

Res-Find is a lightweight Chrome extension with zero external dependencies. It automatically sniffs all media resources loaded on any web page and provides convenient preview, download, and merge functionality. Whether it's ordinary images, background music, or streaming video (HLS/DASH), it captures them all effortlessly.

---

## Features

- **Auto Sniffing** -- Automatically captures images, videos, audio, and HLS/DASH streams on page load without manual intervention
- **Multi-Dimensional Detection** -- Combines `webRequest` API, `PerformanceObserver`, `MutationObserver`, and `IntersectionObserver` to ensure even dynamically loaded and lazy-loaded resources are captured
- **JS-Level Hooks** -- Via `injected.js` running in the page's MAIN World, intercepts `HTMLMediaElement.src` assignments, `fetch/XHR` response bodies, `Audio()` constructor calls, and `URL.createObjectURL` to capture media URLs loaded by frameworks
- **Category Filters** -- Filter by type (image/video/audio/stream), format (PNG/MP4/M3U8, etc.), or file size
- **Keyword Search** -- Search by resource name or URL to quickly locate targets
- **Inline Preview** -- Click any resource to preview images, play audio/video, or view stream info
- **One-Click Download** -- Download individually or batch-select and download them together
- **Smart Naming** -- Automatically extracts human-readable filenames from the DOM context (`alt`, `title`, `figcaption`, headings, etc.), avoiding garbled hash-based filenames
- **Manual Rename** -- Rename resources directly in the popup and manually correct resource types
- **Sniffing Toggle** -- Enable/disable sniffing anytime to reduce clutter for the current tab
- **Audio-Video Merge** -- Combine separate video and audio streams into a single file with an audio track, entirely client-side via `MediaRecorder`
- **Site-Specific Support** -- Built-in extraction from global data structures of Bilibili (`__INITIAL_STATE__`), Douyin/TikTok (`_ROUTER_DATA`), Next.js SSR pages, and more

## Installation

### Install from Source (Developer Mode)

1. **Clone the repo**
   ```bash
   git clone https://github.com/your-username/res-find.git
   cd res-find
   ```

2. **Load into Chrome**
   - Open Chrome and navigate to `chrome://extensions`
   - Enable **Developer mode** in the top-right corner
   - Click **Load unpacked**
   - Select the `res-find` directory

### Install from Chrome Web Store

> Coming soon.

## Usage

### Basic Workflow

1. Open any web page containing images, videos, or audio
2. Click the Res-Find icon in the Chrome toolbar
3. The popup lists all resources sniffed from the current page
4. Use the top tabs to filter by type (All / Images / Video / Audio / Stream)
5. Further filter by format (PNG / MP4 / M3U8, etc.) or file size
6. Type a keyword in the search bar to quickly locate resources
7. Click the download button on any resource to save it

### Resource Preview

Click any resource item to open a preview popup:
- **Image** -- Enlarged display of the image
- **Video** -- Plays using the browser's native player
- **Audio** -- Displays a waveform icon with playback controls
- **Stream** -- Shows a notice that live preview is not supported; download or open in an external player

### Batch Operations

Select multiple resources and the bottom action bar shows **Download Selected**. If the selection includes pairable video+audio streams, an **Audio-Video Merge Download** button will also appear.

### Audio-Video Merge

When a page loads video and audio as separate streams (common on Bilibili and other DASH-based sites):

1. Select both the video stream and audio stream in the resource list (they will have a purple left border and group badge)
2. Click the **Audio-Video Merge Download** button
3. The extension downloads the video and audio files separately
4. The merge page opens automatically; preview both streams, then click **Start Merge**
5. Download the merged video file when complete

> Note: Merging is performed entirely client-side using the `MediaRecorder` API -- no server required.
> Some sites use DRM-encrypted streams which cannot be merged client-side.

### Sniffing Toggle

The eye icon button in the popup header enables/disables sniffing for the current page. When disabled, no new resources are captured, but previously discovered resources are preserved.

### Resource Type Correction

If a resource is misclassified (e.g., a video stream identified as audio), use the dropdown menu on the resource item to manually correct its type.

### Renaming

Click the rename button (pencil icon) next to the resource name to edit the display name directly, making it easier to find and organize resources later.

## Project Structure

```
res-find/
├── manifest.json         # Chrome Extension manifest (Manifest V3)
├── background.js         # Service Worker: resource store, webRequest monitoring, download orchestration
├── content.js            # Content Script: DOM scanning, MutationObserver, site-specific extraction
├── injected.js           # Page MAIN World hook script: intercepts native JS APIs
├── popup.html            # Popup UI
├── popup.css             # Popup styles (dark theme)
├── popup.js              # Popup interaction logic: rendering, filtering, download, preview
├── merge.html            # Audio-video merge page
├── merge.js              # Merge logic (Canvas + MediaRecorder API)
├── generate_icons.py     # Icon generation script (optional, requires Python + Pillow)
├── icons/                # Extension icons
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── README.md             # Chinese documentation
├── README.en.md          # English documentation
└── .gitignore
```

## Tech Stack

| Category | Technology |
| --- | --- |
| Extension Framework | Chrome Extension Manifest V3 |
| Architecture | Service Worker + Content Script bidirectional messaging |
| Resource Sniffing | `webRequest` API + `PerformanceObserver` + `MutationObserver` + `IntersectionObserver` |
| JS-Level Hooks | Monkey-patched `HTMLMediaElement.src`, `fetch`, `XMLHttpRequest`, `Audio()`, `URL.createObjectURL` |
| Audio-Video Merge | `Canvas.captureStream()` + `AudioContext` + `MediaRecorder` API (fully client-side) |
| Language | Vanilla JavaScript / HTML / CSS, zero external dependencies |
| Site Support | Built-in extraction for Bilibili, Douyin/TikTok, Next.js SSR, and more |

## Development

### Prerequisites

- Chrome (>= 88, with Manifest V3 support)
- Python 3 (optional, for generating icons)

### Local Development

This is a pure frontend extension -- no build toolchain required. After making changes, click the **Refresh** button on the extension card in `chrome://extensions`.

### Code Structure Notes

- **background.js** -- The core background script. Manages resource storage for all tabs, sniffs network requests via the `webRequest` API, and handles messages between content scripts and the popup.
- **content.js** -- Injected into every page. Performs DOM scanning, performance entry listening, dynamic element monitoring, and site-specific data extraction.
- **injected.js** -- Injected into the page's MAIN World via a `<script>` tag. Intercepts native JS API calls to capture media URLs before/during loading.
- **popup.js** -- The popup UI controller. Handles resource list rendering, filtering, preview, and download workflows.
- **merge.js** -- Audio-video merge page logic. Uses Canvas to render video frames frame-by-frame and mixes them with external audio.

### Generate Icons

```bash
pip install Pillow
python generate_icons.py
```

### Package for Distribution

```bash
# 1. Go to chrome://extensions and click "Pack extension"
# 2. Select the res-find directory
# 3. The .crx file and .pem private key will be generated
```

Or manually zip the following files for Chrome Web Store upload:

```
manifest.json  background.js  content.js  injected.js  popup.html
popup.css  popup.js  merge.html  merge.js  icons/
```

## FAQ

<details>
<summary><b>The extension can't sniff any resources?</b></summary>

- Make sure the extension is enabled and the sniffing toggle in the popup is turned on
- Some pages use WebSocket or MSE (Media Source Extensions) for loading -- sniffing coverage is limited in those cases
- Try refreshing the page and reopening the popup
- If the page uses a Service Worker to intercept requests, some resources might not be sniffable
</details>

<details>
<summary><b>Downloaded filenames are garbled?</b></summary>

The browser tries to extract readable filenames from the DOM context (`alt`, `title`, `figcaption`, headings, etc.). If it can't determine a meaningful name, it falls back to the last segment of the URL. You can manually rename resources in the popup before downloading.
</details>

<details>
<summary><b>No audio after merging video + audio?</b></summary>

Make sure you selected both the video stream and the audio stream. Some sites use DRM-encrypted streams which can't be merged client-side. Also ensure the browser tab is not muted during the merge process.
</details>

<details>
<summary><b>Does this conflict with other extensions?</b></summary>

Res-Find uses standard Manifest V3 APIs and should not conflict with other extensions. If you encounter issues, try troubleshooting in incognito mode with other extensions disabled.
</details>

<details>
<summary><b>How can I contribute?</b></summary>

Issues and Pull Requests are welcome! See the contributing guide below.
</details>

## Contributing

Issues and Pull Requests are welcome!

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Commit your changes: `git commit -m "feat: add your feature"`
4. Push the branch: `git push origin feat/your-feature`
5. Open a Pull Request

## License

[MIT](./LICENSE) &copy; Res-Find Contributors

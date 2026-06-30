# Res-Find

Sniff images, videos, HLS/DASH streams, and audio resources from any web page — download with one click.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-brightgreen?logo=googlechrome)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
![License](https://img.shields.io/badge/License-MIT-green)

---

## Features

- **Auto Sniffing** — Automatically captures images, videos, audio, and HLS/DASH streams on page load
- **Live Monitoring** — Dual detection via `MutationObserver` + `PerformanceObserver` catches dynamically loaded resources too
- **Category Filters** — Filter by type (image/video/audio/stream), format, or file size
- **Preview** — Click any resource to preview images or play audio/video inline
- **One-Click Download** — Download individually or batch-select and pack them together
- **Smart Naming** — Extracts human-readable filenames from the page context instead of hash-based URLs
- **Sniffing Toggle** — Enable/disable sniffing anytime to reduce clutter
- **Audio-Video Merge** — Combine separate video and audio streams into a single file with audio track (client-side via `MediaRecorder`)

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

1. Open any web page that contains images, videos, or audio
2. Click the Res-Find icon in the Chrome toolbar
3. The popup lists all resources sniffed from the current page
4. Use the top tabs to filter by type (All / Images / Video / Audio / Stream)
5. Click the download button on any resource to save it

### Preview Resources

Click any resource item to open a preview popup — view images or play audio/video directly.

### Batch Operations

Select multiple resources and click **Download Selected**, or use the **Merge Download** feature.

### Audio-Video Merge

When a page loads video and audio as separate streams (common on certain streaming sites):

1. Locate the video stream and audio stream in the resource list
2. Click the **Merge** button to open the merge page
3. Preview both streams, then click **Start Merge**
4. Download the merged video file when complete

### Sniffing Toggle

The eye icon button in the popup header enables/disables sniffing for the current page. When disabled, no new resources are captured.

## Project Structure

```
res-find/
├── manifest.json         # Chrome Extension manifest (Manifest V3)
├── background.js         # Service Worker: resource store, download orchestration
├── content.js            # Content Script: page sniffing logic
├── popup.html            # Popup UI
├── popup.css             # Popup styles
├── popup.js              # Popup interaction logic
├── merge.html            # Audio-video merge page
├── merge.js              # Merge logic (MediaRecorder API)
├── generate_icons.py     # Icon generation script (optional)
├── icons/                # Extension icons
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── README.md             # Chinese documentation
├── README.en.md          # English documentation
└── .gitignore
```

## Tech Stack

| Category          | Technology                                                         |
| ----------------- | ------------------------------------------------------------------ |
| Extension         | Chrome Extension Manifest V3                                       |
| Architecture      | Service Worker + Content Script messaging                          |
| Resource Sniffing | `PerformanceObserver` + `MutationObserver` + `webRequest` API      |
| Audio-Video Merge | `MediaRecorder` API (client-side, no server needed)                |
| Language          | Vanilla JavaScript / HTML / CSS, zero external dependencies        |

## Development

### Prerequisites

- Chrome (>= 88, with Manifest V3 support)
- Python 3 (optional, for generating icons)

### Local Development

This is a pure frontend extension — no build toolchain required. After making changes, click the **Refresh** button on the extension card in `chrome://extensions`.

### Generate Icons

```bash
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
manifest.json  background.js  content.js  popup.html
popup.css  popup.js  merge.html  merge.js  icons/
```

## FAQ

<details>
<summary><b>The extension can't sniff any resources?</b></summary>

- Make sure the extension is enabled and the sniffing toggle in the popup is turned on
- Some pages use WebSocket or MediaSource for loading — sniffing coverage is limited in those cases
- Try refreshing the page and reopening the popup
</details>

<details>
<summary><b>Downloaded filenames are garbled?</b></summary>

The browser tries to extract readable filenames from the page context. If it can't determine a meaningful name, it falls back to the last segment of the URL.
</details>

<details>
<summary><b>No audio after merging video + audio?</b></summary>

Make sure you selected both the video stream and the audio stream. Some sites use DRM-encrypted streams which can't be merged client-side.
</details>

## Contributing

Issues and Pull Requests are welcome!

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Commit your changes: `git commit -m "feat: add your feature"`
4. Push the branch: `git push origin feat/your-feature`
5. Open a Pull Request

## License

[MIT](./LICENSE) © Res-Find Contributors

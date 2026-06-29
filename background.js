// Res-Find Background Service Worker
// Manages resource store, webRequest monitoring, download orchestration

const tabResources = new Map();       // tabId -> Set<url> (dedup)
const tabResourceMeta = new Map();    // tabId -> Map<url, ResourceMeta>

const RESOURCE_TTL = 15 * 60 * 1000;  // 15 minutes

// ---- Resource classification ----

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico|tiff?)\b/i;
const VIDEO_EXT = /\.(mp4|webm|ogg|mov|avi|mkv|flv|wmv|m4v|3gp)\b/i;
const AUDIO_EXT = /\.(mp3|wav|flac|aac|ogg|wma|m4a|opus|aiff)\b/i;
const STREAM_PATTERN = /\.(m3u8|mpd)\b/i;
const STREAM_KEYWORD = /m3u8|mpd|manifest|playlist|chunklist|segment|media\.ts/i;
const IMAGE_CONTENT = /^image\//;
const VIDEO_CONTENT = /^video\//;
const AUDIO_CONTENT = /^audio\//;
const STREAM_CONTENT = /application\/(x-mpegurl|vnd\.apple\.mpegurl|dash\+xml)|text\/uri-list/i;

function classifyResource(url, contentType) {
  if (STREAM_PATTERN.test(url) || STREAM_CONTENT.test(contentType) || STREAM_KEYWORD.test(url)) {
    return 'stream';
  }
  if (VIDEO_EXT.test(url) || VIDEO_CONTENT.test(contentType)) return 'video';
  if (AUDIO_EXT.test(url) || AUDIO_CONTENT.test(contentType)) return 'audio';
  if (IMAGE_EXT.test(url) || IMAGE_CONTENT.test(contentType)) return 'image';
  return null; // uncategorized
}

// ---- Resource store ----

function getFilename(url, type) {
  try {
    const u = new URL(url);
    const path = u.pathname.split('/').filter(Boolean);
    return path.length > 0 ? decodeURIComponent(path.pop()) : `${type}_${Date.now()}`;
  } catch {
    return `${type}_${Date.now()}`;
  }
}

function formatSize(bytes) {
  if (!bytes || bytes === -1) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function addResource(tabId, url, type, metadata) {
  if (!url || url.startsWith('data:') || url.startsWith('blob:chrome-extension')) return;
  if (!tabResources.has(tabId)) {
    tabResources.set(tabId, new Set());
    tabResourceMeta.set(tabId, new Map());
  }
  const seen = tabResources.get(tabId);
  if (seen.has(url)) return;
  seen.add(url);

  const meta = tabResourceMeta.get(tabId);
  const filename = getFilename(url, type);
  const entry = {
    url,
    type,
    filename,
    detectedAt: Date.now(),
    pageUrl: metadata.pageUrl || '',
    size: metadata.size || -1,
    sizeFormatted: formatSize(metadata.size),
    contentType: metadata.contentType || '',
    initiator: metadata.initiator || '',
    tabId
  };
  meta.set(url, entry);
}

function getResourcesForTab(tabId) {
  const meta = tabResourceMeta.get(tabId);
  return meta ? Array.from(meta.values()) : [];
}

function clearTabResources(tabId) {
  tabResources.delete(tabId);
  tabResourceMeta.delete(tabId);
}

function clearExpired() {
  const cutoff = Date.now() - RESOURCE_TTL;
  for (const [tabId, meta] of tabResourceMeta) {
    for (const [url, entry] of meta) {
      if (entry.detectedAt < cutoff) {
        meta.delete(url);
        tabResources.get(tabId)?.delete(url);
      }
    }
    if (meta.size === 0) {
      tabResources.delete(tabId);
      tabResourceMeta.delete(tabId);
    }
  }
}
setInterval(clearExpired, 60 * 1000);

// ---- webRequest monitoring ----

const pendingRequests = new Map(); // requestId -> { url, tabId, initiator }

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const type = classifyResource(details.url, '');
    if (type) {
      addResource(details.tabId, details.url, type, {
        pageUrl: details.initiator || details.documentUrl || '',
        contentType: '',
        size: -1,
        initiator: details.initiator || ''
      });
    }
    pendingRequests.set(details.requestId, {
      url: details.url,
      tabId: details.tabId,
      initiator: details.initiator || details.documentUrl || ''
    });
  },
  { urls: ['<all_urls>'] }
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    const pending = pendingRequests.get(details.requestId);
    pendingRequests.delete(details.requestId);
    if (!pending || details.tabId < 0) return;

    const contentType = (details.responseHeaders || [])
      .find(h => h.name.toLowerCase() === 'content-type')?.value || '';
    const size = (details.responseHeaders || [])
      .find(h => h.name.toLowerCase() === 'content-length')?.value;
    const sizeNum = size ? parseInt(size, 10) : -1;

    const type = classifyResource(pending.url, contentType);
    if (type) {
      addResource(details.tabId, pending.url, type, {
        pageUrl: pending.initiator || details.documentUrl || '',
        contentType,
        size: sizeNum,
        initiator: pending.initiator
      });
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    pendingRequests.delete(details.requestId);
  },
  { urls: ['<all_urls>'] }
);

// ---- Tab cleanup ----

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabResources(tabId);
});

// ---- Messaging ----

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'report_resource': {
      const tabId = sender.tab?.id || message.tabId;
      if (tabId >= 0) {
        addResource(tabId, message.url, message.type, {
          pageUrl: message.pageUrl || sender.url || '',
          contentType: message.contentType || '',
          size: message.size || -1,
          initiator: message.initiator || ''
        });
      }
      sendResponse({ ok: true });
      break;
    }

    case 'get_resources': {
      const tabId = message.tabId;
      const resources = getResourcesForTab(tabId);
      sendResponse({ resources });
      break;
    }

    case 'clear_resources': {
      const tabId = message.tabId;
      clearTabResources(tabId);
      sendResponse({ ok: true });
      break;
    }

    case 'download_resource': {
      const { url, filename } = message;
      chrome.downloads.download({
        url,
        filename: filename || undefined,
        conflictAction: 'uniquify',
        saveAs: false
      }).catch(err => console.error('Download failed:', err));
      sendResponse({ ok: true });
      break;
    }

    case 'get_tab_resources_count': {
      const tabId = message.tabId;
      const resources = getResourcesForTab(tabId);
      sendResponse({ count: resources.length });
      break;
    }
  }
  return true; // keep channel open for async response
});

// ---- Service worker keepalive via storage ----

chrome.runtime.onInstalled.addListener(() => {
  console.log('Res-Find installed. Ready to sniff resources.');
});

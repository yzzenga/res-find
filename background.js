// Res-Find Background Service Worker
// Manages resource store, webRequest monitoring, download orchestration

const tabResources = new Map();       // tabId -> Set<url> (dedup)
const tabResourceMeta = new Map();    // tabId -> Map<url, ResourceMeta>
const disabledTabs = new Set();       // tabId -> sniffing is disabled

const RESOURCE_TTL = 15 * 60 * 1000;  // 15 minutes

// ---- Resource classification ----

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico|tiff?)\b/i;
const VIDEO_EXT = /\.(mp4|webm|ogg|mov|avi|mkv|flv|wmv|m4v|3gp|m4s|ts)\b/i;
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

// Detect meaningless auto-generated filenames (blob hashes, UUIDs, base64, random)
function looksLikeRandomHash(str) {
  if (!str || str.length < 8) return false;
  const s = String(str);
  // Pure hex (MD5/SHA1 UUID without dashes, blob UUIDs)
  if (/^[a-f0-9]{16,}$/i.test(s)) return true;
  // UUID with dashes: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s)) return true;
  // Base64-like (≥20 chars with mixed case + digits + special chars)
  if (/^[a-zA-Z0-9+/=_\-]{20,}$/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s)) return true;
  // Long mixed alphanumeric without separators (≥24 chars) — blob UUIDs hit this
  if (/^[a-zA-Z0-9]{24,}$/.test(s)) return true;
  // data: URIs and blob: URLs (the origin part is meaningful, the hash isn't)
  if (/^data:/i.test(s) || /^blob:/i.test(s)) return true;
  return false;
}

// Map URL extension to a display format label (e.g., "PNG", "MP4", "M3U8")
function guessFormat(url, type) {
  const ext = tryGetExtension(url) || '';
  // Known format map
  const fmtMap = {
    png: 'PNG', jpg: 'JPEG', jpeg: 'JPEG', gif: 'GIF', webp: 'WEBP',
    avif: 'AVIF', bmp: 'BMP', svg: 'SVG', ico: 'ICO', tif: 'TIFF', tiff: 'TIFF',
    mp4: 'MP4', webm: 'WEBM', ogv: 'OGV', mov: 'MOV', avi: 'AVI',
    mkv: 'MKV', flv: 'FLV', wmv: 'WMV', m4v: 'M4V', '3gp': '3GP',
    mp3: 'MP3', wav: 'WAV', flac: 'FLAC', aac: 'AAC', m4a: 'M4A',
    ogg: 'OGG', opus: 'OPUS', wma: 'WMA', aiff: 'AIFF',
    m3u8: 'M3U8', mpd: 'MPD'
  };
  if (fmtMap[ext]) return fmtMap[ext];
  // Stream keywords in URL but no recognized ext
  if (type === 'stream' && /m3u8/i.test(url)) return 'M3U8';
  if (type === 'stream' && /mpd/i.test(url)) return 'MPD';
  // Fallback: uppercase the extension
  if (ext && ext.length <= 5) return ext.toUpperCase();
  return type === 'image' ? 'IMG' : type === 'video' ? 'VID' : type === 'audio' ? 'AUD' : type === 'stream' ? 'STRM' : '?';
}

function getFilename(url, type, nameHint) {
  // Prefer explicit name from content script (alt/title attribute)
  if (nameHint && nameHint.length > 2 && nameHint.length < 200 && !looksLikeRandomHash(nameHint)) {
    // Sanitize: remove excessive whitespace, strip invalid filename chars
    let clean = nameHint.trim()
      .replace(/[<>:"\/\\|?*\x00-\x1f]/g, '')
      .replace(/\s+/g, ' ');
    // Append extension if the name doesn't have one but the URL does
    if (clean.length > 0 && clean.length < 150) {
      const urlExt = tryGetExtension(url);
      if (urlExt && !clean.toLowerCase().endsWith('.' + urlExt)) {
        clean += '.' + urlExt;
      }
      return clean;
    }
  }
  // Fallback: extract from URL path
  try {
    const u = new URL(url);
    const raw = decodeURIComponent(u.pathname);
    const segments = raw.split('/').filter(Boolean);

    // Check query params for meaningful filenames (works for many CDN URLs)
    const queryFile = u.searchParams.get('file')
      || u.searchParams.get('filename')
      || u.searchParams.get('name')
      || u.searchParams.get('image')
      || u.searchParams.get('video')
      || u.searchParams.get('src')
      || u.searchParams.get('url');
    if (queryFile) {
      const qName = queryFile.split('/').pop()?.split('?')[0];
      if (qName && qName.length > 2 && qName.length < 200 && !looksLikeRandomHash(qName)) {
        return decodeURIComponent(qName);
      }
    }

    if (segments.length > 0) {
      let name = segments[segments.length - 1];
      const nameBase = name.replace(/\.[^.]+$/, '');

      if (looksLikeRandomHash(nameBase)) {
        // Try previous path segment as context prefix (for uniqueness)
        if (segments.length > 1) {
          const prev = decodeURIComponent(segments[segments.length - 2]);
          if (prev && prev.length > 1 && prev.length < 60 && !looksLikeRandomHash(prev)) {
            const ext = tryGetExtension(url);
            return ext ? `${prev}_${type}.${ext}` : `${prev}_${type}`;
          }
        }
        // Fall through to domain+type below
      } else {
        if (name.length < 200) return name;
      }
    }
    // Use domain + path context + type for uniqueness (avoids duplicate names)
    const domain = u.hostname.replace(/^www\./, '').replace(/[^a-zA-Z0-9]/g, '_');
    const ext = tryGetExtension(url);
    // Include up to 3 meaningful path segments for disambiguation
    const context = segments
      .slice(0, -1)
      .map(s => decodeURIComponent(s))
      .filter(s => s && s.length > 1 && !looksLikeRandomHash(s))
      .slice(-2)
      .join('_');
    if (context) {
      return ext ? `${domain}_${context}_${type}.${ext}` : `${domain}_${context}_${type}`;
    }
    // Absolute last resort: use a short tag from the URL to avoid duplicates
    const urlTag = url.replace(/[?#].*/, '').slice(-12).replace(/[^a-zA-Z0-9]/g, '');
    return ext
      ? `${domain}_${type}_${urlTag}.${ext}`
      : `${domain}_${type}_${urlTag}`;
  } catch {
    return `${type}`;
  }
}

function tryGetExtension(url) {
  const m = url.match(/\.([a-z0-9]+)(?:[\?#]|$)/i);
  return m ? m[1].toLowerCase() : '';
}

function cleanUrl(url) {
  // Remove tracking params for display, keep for download
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch { return url; }
}

function formatSize(bytes) {
  if (!bytes || bytes === -1) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Strip range/chunk/part query params that fragment a single resource into duplicates
function normalizeResourceUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const stripParams = ['range', 'part', 'seg', 'chunk', 'bytestart', 'byteend'];
    for (const p of stripParams) {
      if (u.searchParams.has(p)) u.searchParams.delete(p);
    }
    const normalized = u.href;
    // If after stripping params the URL is meaningfully shorter, use it
    if (normalized.length < rawUrl.length - 5) return normalized;
  } catch {}
  return rawUrl;
}

function addResource(tabId, rawUrl, type, metadata) {
  if (disabledTabs.has(tabId)) return;
  const url = normalizeResourceUrl(rawUrl);
  if (!url || url.startsWith('data:') || url.startsWith('blob:chrome-extension')) return;
  if (!tabResources.has(tabId)) {
    tabResources.set(tabId, new Set());
    tabResourceMeta.set(tabId, new Map());
  }
  const meta = tabResourceMeta.get(tabId);

  // URL already exists — update name if scanDOM found a better one
  if (tabResources.get(tabId).has(url)) {
    const existing = meta.get(url);
    if (existing && metadata.name && metadata.name.length > 2 && !looksLikeRandomHash(metadata.name)) {
      const oldName = existing.name || '';
      const oldFilename = existing.filename || '';
      if (!oldName || oldName === oldFilename || looksLikeRandomHash(oldName)) {
        existing.name = metadata.name;
        existing.filename = getFilename(url, existing.type, metadata.name);
      }
    }
    return;
  }

  tabResources.get(tabId).add(url);
  const filename = getFilename(url, type, metadata.name);
  const format = guessFormat(url, type);
  const entry = {
    url,
    type,
    format,
    filename,
    detectedAt: Date.now(),
    pageUrl: metadata.pageUrl || '',
    size: metadata.size || -1,
    sizeFormatted: formatSize(metadata.size),
    contentType: metadata.contentType || '',
    initiator: metadata.initiator || '',
    name: metadata.name || filename,
    groupId: metadata.groupId || '',
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
  disabledTabs.delete(tabId);
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
          initiator: message.initiator || '',
          name: message.name || '',
          groupId: message.groupId || ''
        });
      }
      sendResponse({ ok: true });
      break;
    }

    case 'update_resource_name': {
      // Retroactively set a better name for an already-detected resource
      const tabId = sender.tab?.id || message.tabId;
      if (tabId >= 0 && message.url && message.name) {
        const meta = tabResourceMeta.get(tabId);
        if (meta) {
          const entry = meta.get(message.url);
          if (entry && (!entry.name || entry.name === entry.filename)) {
            entry.name = message.name;
            entry.filename = getFilename(message.url, entry.type, message.name);
          }
        }
      }
      sendResponse({ ok: true });
      break;
    }

    case 'rename_resource': {
      // Rename a resource's display name and filename
      const tabId = sender.tab?.id || message.tabId;
      if (tabId >= 0 && message.url && message.newName) {
        const meta = tabResourceMeta.get(tabId);
        if (meta) {
          const entry = meta.get(message.url);
          if (entry) {
            entry.name = message.newName;
            entry.filename = getFilename(message.url, entry.type, message.newName);
          }
        }
      }
      sendResponse({ ok: true });
      break;
    }

    case 'change_resource_type': {
      // Manually override a resource's type (e.g. video -> audio for misidentified streams)
      const tabId = sender.tab?.id || message.tabId;
      if (tabId >= 0 && message.url && message.newType) {
        const meta = tabResourceMeta.get(tabId);
        if (meta) {
          const entry = meta.get(message.url);
          if (entry) {
            entry.type = message.newType;
            entry.format = guessFormat(entry.url, message.newType);
            entry.filename = getFilename(entry.url, message.newType, entry.name);
          }
        }
      }
      sendResponse({ ok: true });
      break;
    }

    case 'merge_download': {
      // Download paired video+audio and open merge page
      const { videoUrl, audioUrl, baseName, tabId: msgTabId } = message;
      const tid = sender.tab?.id || msgTabId;
      chrome.downloads.download({ url: videoUrl, filename: `${baseName}_video.mp4` });
      chrome.downloads.download({ url: audioUrl, filename: `${baseName}_audio.mp4` });
      // Open merge utility page
      const mergeUrl = chrome.runtime.getURL('merge.html')
        + `?video=${encodeURIComponent(videoUrl)}`
        + `&audio=${encodeURIComponent(audioUrl)}`
        + `&name=${encodeURIComponent(baseName)}`;
      chrome.tabs.create({ url: mergeUrl, active: false });
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

    case 'get_tab_sniffing_state': {
      const tabId = message.tabId;
      sendResponse({ disabled: disabledTabs.has(tabId) });
      break;
    }

    case 'toggle_tab_sniffing': {
      const tabId = message.tabId;
      if (disabledTabs.has(tabId)) {
        disabledTabs.delete(tabId);
        // Notify content script to resume sniffing
        chrome.tabs.sendMessage(tabId, { action: 'setSniffing', enabled: true }).catch(() => {});
        sendResponse({ disabled: false });
      } else {
        disabledTabs.add(tabId);
        // Notify content script to stop sniffing
        chrome.tabs.sendMessage(tabId, { action: 'setSniffing', enabled: false }).catch(() => {});
        sendResponse({ disabled: true });
      }
      break;
    }
  }
  return true; // keep channel open for async response
});

// ---- Service worker keepalive via storage ----

chrome.runtime.onInstalled.addListener(() => {
  console.log('Res-Find installed. Ready to sniff resources.');
});

// Res-Find Content Script
// Sniffs resources via PerformanceObserver, DOM scanning, MutationObserver

(function () {
  'use strict';

  if (window.__resFindInjected) return;
  window.__resFindInjected = true;

  const SCAN_INTERVAL = 3000;     // full DOM scan every 3s
  const BATCH_DEBOUNCE = 500;     // batch resource reports
  const STREAM_KEYWORDS = /m3u8|mpd|\.ts\b|segment|chunklist|manifest/i;

  let pendingBatch = new Map();    // url -> { url, type, ... }
  let batchTimer = null;
  let scanTimer = null;
  let observer = null;
  let sniffingEnabled = true;      // controlled by popup toggle
  let extensionInvalidated = false; // set to true when chrome.runtime dies

  // When extension context is invalidated we just set a flag that gates
  // all further extension API calls. Timers/observers remain alive but
  // return early — no cleanup needed since the page will eventually
  // navigate or be refreshed.
  function handleInvalidated() {
    if (extensionInvalidated) return;
    extensionInvalidated = true;
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
  }

  // ---- Helpers ----

  function classifyByUrl(url) {
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) return null;
    const u = url.split('?')[0].split('#')[0];
    if (/\.(m3u8|mpd)\b/i.test(u)) return 'stream';
    if (/\.(png|jpe?g|gif|webp|avif|bmp|svg|ico|tiff?)\b/i.test(u)) return 'image';
    if (/\.(mp4|webm|ogg|mov|avi|mkv|flv|wmv|m4v|3gp|m4s|ts)\b/i.test(u)) return 'video';
    if (/\.(mp3|wav|flac|aac|wma|m4a|opus|aiff)\b/i.test(u)) return 'audio';
    if (STREAM_KEYWORDS.test(u)) return 'stream';
    return null;
  }

  function normalizedUrl(url) {
    try {
      const u = new URL(url, location.href);
      return u.href.split('#')[0];
    } catch { return url; }
  }

  // A name is "good" if it looks like a real human-readable title (not a hash/URL/auto-generated)
  function isGoodName(name) {
    if (!name || name.length < 3 || name.length > 200) return false;
    // Skip pure random hashes
    if (/^[a-f0-9]{16,}$/i.test(name)) return false;
    if (/^[a-zA-Z0-9]{24,}$/.test(name)) return false;
    // Must contain at least one CJK, letter, or meaningful character
    if (!/[\u4e00-\u9fff\w]/.test(name)) return false;
    return true;
  }

  function reportResource(url, type, extra) {
    const normalized = normalizedUrl(url);
    const existing = pendingBatch.get(normalized);
    if (existing) {
      // URL already pending — update name/groupId if incoming one is better
      if (extra?.name && isGoodName(extra.name)) {
        const oldName = existing.name || '';
        if (!oldName || !isGoodName(oldName)) {
          existing.name = extra.name;
        }
      }
      if (extra?.groupId && !existing.groupId) {
        existing.groupId = extra.groupId;
      }
      return;
    }
    const entry = {
      url: normalized,
      type: type || classifyByUrl(url) || 'unknown',
      name: extra?.name || '',
      pageUrl: location.href,
      contentType: extra?.contentType || '',
      size: extra?.size || -1,
      initiator: extra?.initiator || location.href
    };
    if (extra?.groupId) entry.groupId = extra.groupId;
    pendingBatch.set(normalized, entry);
    scheduleFlush();
  }

  // Try to derive a human-readable name from a media element
  function deriveName(element, url) {
    // Priority: title > alt > aria-label > data-* > parent context > surrounding text
    let name = element.getAttribute('title')
      || element.getAttribute('alt')
      || element.getAttribute('aria-label')
      || element.dataset.title
      || element.dataset.name
      || element.getAttribute('name');
    if (name && name.trim().length > 0 && name.trim().length < 150) {
      return name.trim();
    }
    // For images: check parent link content / figcaption / parent heading
    if (element.tagName === 'IMG') {
      const parent = element.parentElement;
      if (parent) {
        // <a><img></a> → link text or title
        if (parent.tagName === 'A') {
          if (parent.title && parent.title.trim().length > 0) return parent.title.trim();
          const aText = parent.textContent.trim();
          if (aText && aText.length > 1 && aText.length < 120) return aText;
        }
        // <figure><img><figcaption>caption</figcaption></figure>
        const figcaption = parent.querySelector('figcaption');
        if (figcaption && figcaption.textContent.trim().length > 0) {
          return figcaption.textContent.trim().slice(0, 150);
        }
        // Check sibling headings or parent headings
        const heading = parent.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4')
          || element.closest('section, article, div[class*="media"]')?.querySelector('h1, h2, h3, h4');
        if (heading && heading.textContent.trim().length > 0) {
          return heading.textContent.trim().slice(0, 150);
        }
      }
    }
    // For video/audio: comprehensive context extraction
    if (element.tagName === 'VIDEO' || element.tagName === 'AUDIO') {
      return deriveVideoName(element, url);
    }
    return '';
  }

  // Deep context extraction for video/audio elements
  function deriveVideoName(element, url) {
    // 1) poster attribute → extract readable name
    if (element.tagName === 'VIDEO' && element.poster) {
      const pName = decodeURIComponent(element.poster.split('/').pop()?.split('?')[0] || '')
        .replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
      if (pName && pName.length > 3 && pName.length < 100) return pName;
    }

    // 2) Check <figure> + <figcaption> — most specific media container
    const figure = element.closest('figure');
    if (figure) {
      const figCaption = figure.querySelector('figcaption');
      if (figCaption && figCaption.textContent.trim().length > 0) {
        return figCaption.textContent.trim().slice(0, 150);
      }
    }

    // 3) Check previous sibling (title is often directly above the video)
    const prev = element.previousElementSibling;
    if (prev) {
      const t = prev.textContent.trim();
      if (t && t.length > 3 && t.length < 200) return t;
    }

    // 4) Walk up 4 parent levels — aria-label, title, dedicated title elements
    let el = element.parentElement;
    for (let depth = 0; depth < 4 && el; depth++) {
      const label = el.getAttribute('aria-label') || el.getAttribute('title');
      if (label && label.trim().length > 2 && label.trim().length < 200) {
        return label.trim();
      }
      // Look for dedicated title elements (but skip generic <h1> that are page titles)
      const titleEl = el.querySelector(
        ':scope > [class*="title"], :scope > [class*="heading"], ' +
        ':scope > [class*="headline"], :scope > [class*="name"], ' +
        ':scope > h2, :scope > h3, :scope > h4'
      );
      if (titleEl) {
        const t = titleEl.textContent.trim();
        if (t && t.length > 2 && t.length < 200) return t;
      }
      el = el.parentElement;
    }

    // 5) Check parent's previous sibling (title in a container sibling)
    if (element.parentElement) {
      const parentSibling = element.parentElement.previousElementSibling;
      if (parentSibling) {
        const t = parentSibling.textContent.trim();
        if (t && t.length > 5 && t.length < 200) return t;
      }
    }

    // 6) Feed-style card layout: walk up 6 levels and look for title/desc elements
    // (handles Douyin, Bilibili feed, and other video-card layouts)
    {
      let card = element.parentElement;
      for (let depth = 0; depth < 6 && card; depth++) {
        // Look for title/desc elements anywhere inside this card (not just :scope >)
        const titleEl = card.querySelector(
          '[class*="title"]:not([class*="subtitle"]):not([class*="tooltip"]), ' +
          '[class*="desc"]:not([class*="description"]), ' +
          '[class*="video-info"], [class*="card-title"], ' +
          '[class*="feed-title"], [class*="item-title"]'
        );
        if (titleEl) {
          const t = titleEl.textContent.trim();
          if (t && t.length > 2 && t.length < 200) return t;
        }
        // Also check data-title or aria-label on the card itself
        const cardLabel = card.getAttribute('data-title') || card.getAttribute('aria-label');
        if (cardLabel && cardLabel.length > 2 && cardLabel.length < 200) return cardLabel;
        card = card.parentElement;
      }
    }

    // 7) Check JSON-LD structured data for VideoObject (works on any page)
    try {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of scripts) {
        const data = JSON.parse(script.textContent);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if (item['@type'] === 'VideoObject' && item.name) return item.name;
          if ((item['@type'] === 'NewsArticle' || item['@type'] === 'Article') && item.video) {
            const v = Array.isArray(item.video) ? item.video[0] : item.video;
            if (v && v.name) return v.name;
          }
        }
      }
    } catch (e) { /* invalid JSON-LD */ }

    // 7) URL path as last resort — but skip blob: and random hash URLs
    const isBlobOrRandom = !url || url.startsWith('blob:') || /^[a-zA-Z0-9]{16,}$/.test(url.split('/').pop()?.split('?')[0] || '');
    if (!isBlobOrRandom) {
      try {
        const path = new URL(url).pathname.split('/').filter(Boolean);
        if (path.length > 0) {
          return decodeURIComponent(path.pop().split('?')[0])
            .replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
        }
      } catch (e) { /* ignore */ }
    }

    return '';
  }

  // Reverse DOM lookup: find a DOM element whose src/href matches the given URL
  function findElementByUrl(resourceUrl) {
    try {
      const u = new URL(resourceUrl);
      const absUrl = u.href;
      const pathOnly = u.pathname;
      // Try exact src match for known media tags
      const selectors = [
        `img[src="${absUrl}"]`,
        `video[src="${absUrl}"]`,
        `audio[src="${absUrl}"]`,
        `source[src="${absUrl}"]`,
        `a[href="${absUrl}"]`,
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
      // Try just the pathname (handles different origins or protocol-relative)
      if (pathOnly && pathOnly.length > 10) {
        const pathSelectors = [
          `img[src*="${pathOnly}"]`,
          `video[src*="${pathOnly}"]`,
          `audio[src*="${pathOnly}"]`,
          `source[src*="${pathOnly}"]`,
        ];
        for (const sel of pathSelectors) {
          const el = document.querySelector(sel);
          if (el) return el;
        }
      }
    } catch (e) { /* ignore invalid URLs */ }
    return null;
  }

  // Find og/twitter meta tag content for a media URL
  function findNameFromMeta(resourceUrl) {
    try {
      const url = new URL(resourceUrl).href;
      // Check og:image, og:video, og:audio, twitter:image
      const metas = document.querySelectorAll('meta[property^="og:"], meta[property^="twitter:"]');
      for (const meta of metas) {
        const content = meta.getAttribute('content');
        if (content && (content === url || new URL(content).href === url)) {
          // Found match - look for corresponding title meta
          const prop = meta.getAttribute('property');
          const baseProp = prop?.replace(/:(image|video|audio|url)$/, ':title');
          if (baseProp) {
            const titleMeta = document.querySelector(`meta[property="${baseProp}"]`);
            if (titleMeta && titleMeta.getAttribute('content')) {
              return titleMeta.getAttribute('content').trim().slice(0, 150);
            }
          }
        }
      }
    } catch (e) { /* ignore */ }
    return '';
  }

  function scheduleFlush() {
    if (!sniffingEnabled || extensionInvalidated) return;
    if (batchTimer) clearTimeout(batchTimer);
    batchTimer = setTimeout(flushBatch, BATCH_DEBOUNCE);
  }

  function flushBatch() {
    batchTimer = null;
    if (extensionInvalidated) return;
    if (pendingBatch.size === 0) return;
    const entries = Array.from(pendingBatch.values());
    pendingBatch.clear();
    for (const entry of entries) {
      const msg = { action: 'report_resource', ...entry };
      try {
        chrome.runtime.sendMessage(msg).catch(() => {});
      } catch (e) {
        // Extension context invalidated — stop trying to send
        handleInvalidated();
        return;
      }
    }
  }

  // ---- PerformanceObserver ----
  // Names come from URL only here; scanDOM will retroactively update them later

  try {
    const perfObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const type = classifyByUrl(entry.name);
        if (type) {
          // Try to find a DOM element matching this URL for a better name
          const el = findElementByUrl(entry.name);
          const name = el ? deriveName(el, entry.name) : '';
          reportResource(entry.name, type, {
            initiator: entry.initiatorType || '',
            name: name || findNameFromMeta(entry.name)
          });
        }
      }
    });
    perfObserver.observe({ entryTypes: ['resource'] });
  } catch (e) { /* PerformanceObserver not supported */ }

  // Capture existing performance entries
  try {
    performance.getEntriesByType('resource').forEach(entry => {
      const type = classifyByUrl(entry.name);
      if (type) {
        const el = findElementByUrl(entry.name);
        const name = el ? deriveName(el, entry.name) : '';
        reportResource(entry.name, type, {
          initiator: entry.initiatorType || '',
          name: name || findNameFromMeta(entry.name)
        });
      }
    });
  } catch (e) { /* ignore */ }

  // ---- DOM scanning ----

  function scanDOM() {
    if (extensionInvalidated) return;
    const results = [];

    // Images
    document.querySelectorAll('img').forEach(img => {
      if (img.src && !img.src.startsWith('data:')) {
        const type = classifyByUrl(img.src);
        if (type) results.push({ url: img.src, type, name: deriveName(img, img.src) });
      }
      if (img.srcset) {
        img.srcset.split(',').forEach(part => {
          const match = part.trim().match(/^(\S+)/);
          if (match) {
            const url = normalizedUrl(match[1]);
            const type = classifyByUrl(url);
            if (type) results.push({ url, type, name: deriveName(img, url) });
          }
        });
      }
    });

    // Videos & streams
    document.querySelectorAll('video').forEach(video => {
      const vName = deriveName(video, video.src);
      // Check primary src
      if (video.src && !video.src.startsWith('blob:') && !video.src.startsWith('data:')) {
        const url = normalizedUrl(video.src);
        const type = classifyByUrl(url) || 'video';
        results.push({ url, type, name: vName });
      }
      // Check data-src / data-url (Bilibili, Douyin, and other dynamic sites hide real URL here)
      const dataSrc = video.dataset.src || video.dataset.url || video.getAttribute('data-video-src');
      if (dataSrc && !dataSrc.startsWith('blob:') && !dataSrc.startsWith('data:')) {
        const url = normalizedUrl(dataSrc);
        if (url !== video.src) {
          const type = classifyByUrl(url) || 'video';
          results.push({ url, type, name: vName || dataSrc });
        }
      }
      // Check data-vid / data-video / data-stream (used by some streaming sites)
      const dataVid = video.dataset.vid || video.dataset.video || video.dataset.stream;
      if (dataVid && dataVid.length > 5 && !dataVid.startsWith('blob:')) {
        const url = normalizedUrl(dataVid);
        if (classifyByUrl(url) && url !== video.src) {
          results.push({ url, type: 'video', name: vName || dataVid });
        }
      }
      // Source elements
      video.querySelectorAll('source').forEach(source => {
        if (source.src) {
          const url = normalizedUrl(source.src);
          const type = classifyByUrl(url) || 'video';
          results.push({ url, type, name: source.getAttribute('title') || vName });
        }
      });
    });

    // Audio
    document.querySelectorAll('audio').forEach(audio => {
      const aName = deriveName(audio, audio.src);
      if (audio.src) {
        const url = normalizedUrl(audio.src);
        const type = classifyByUrl(url) || 'audio';
        results.push({ url, type, name: aName });
      }
      audio.querySelectorAll('source').forEach(source => {
        if (source.src) {
          const url = normalizedUrl(source.src);
          const type = classifyByUrl(url) || 'audio';
          results.push({ url, type, name: source.getAttribute('title') || aName });
        }
      });
    });

    // Links to media files (direct media URLs)
    document.querySelectorAll('a[href]').forEach(a => {
      const type = classifyByUrl(a.href);
      if (type) results.push({ url: a.href, type, name: a.title || a.textContent.trim().slice(0, 100) });
    });

    // ---- Site-specific video extraction from globals ----

    // Bilibili: window.__INITIAL_STATE__ contains full video URL info
    try {
      const initState = window.__INITIAL_STATE__;
      if (initState) {
        // Bilibili video page: initState.videoInfo
        const videoData = initState.videoInfo || initState.videoData || initState;
        if (videoData) {
          // Bilibili dash video/audio — assign groupId to link paired streams
          const dashGroupId = 'dash_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
          if (videoData.dash && videoData.dash.video) {
            for (let i = 0; i < videoData.dash.video.length; i++) {
              const v = videoData.dash.video[i];
              const url = v.base_url || v.baseUrl || v.url;
              if (url && classifyByUrl(url)) {
                results.push({
                  url, type: 'video',
                  name: videoData.title || initState.title || '',
                  groupId: dashGroupId
                });
              }
            }
          }
          // Paired DASH audio streams
          if (videoData.dash && videoData.dash.audio) {
            for (let i = 0; i < videoData.dash.audio.length; i++) {
              const a = videoData.dash.audio[i];
              const url = a.base_url || a.baseUrl || a.url;
              if (url && classifyByUrl(url)) {
                results.push({
                  url, type: 'audio',
                  name: videoData.title || initState.title || '',
                  groupId: dashGroupId
                });
              }
            }
          }
          // Bilibili flv video: videoData.durl[i].url
          if (videoData.durl) {
            for (const d of videoData.durl) {
              if (d.url && classifyByUrl(d.url)) {
                results.push({ url: d.url, type: 'video', name: videoData.title || initState.title || '' });
              }
            }
          }
          // Direct video URL in some page types
          if (videoData.video_url || videoData.videoUrl) {
            const url = videoData.video_url || videoData.videoUrl;
            if (classifyByUrl(url)) {
              results.push({ url, type: 'video', name: videoData.title || initState.title || '' });
            }
          }
        }
        // Bilibili space/feed pages: initState.videoList or initState.videos
        const vids = initState.videoList || initState.videos || [];
        if (Array.isArray(vids)) {
          for (const v of vids) {
            if (v.pic && classifyByUrl(v.pic)) {
              results.push({ url: v.pic, type: 'image', name: v.title || '' });
            }
          }
        }
      }
    } catch (e) { /* __INITIAL_STATE__ parsing */ }

    // Douyin: window._ROUTER_DATA.loaderData contains video metadata and URLs
    try {
      const routerData = window._ROUTER_DATA;
      if (routerData && routerData.loaderData) {
        const extractDouyinVideos = (obj, depth = 0) => {
          if (depth > 4 || !obj || typeof obj !== 'object') return;
          // Douyin video items have desc (title) and video.play_addr.url_list
          if (obj.desc && obj.video && obj.video.play_addr) {
            const title = obj.desc || '';
            const urls = obj.video.play_addr.url_list || [];
            for (const u of urls) {
              if (typeof u === 'string' && classifyByUrl(u)) {
                results.push({ url: u, type: 'video', name: title });
              }
            }
            return;
          }
          // Recurse into arrays and objects
          for (const key of Object.keys(obj)) {
            try { extractDouyinVideos(obj[key], depth + 1); } catch {}
          }
        };
        extractDouyinVideos(routerData.loaderData);
      }
    } catch (e) { /* _ROUTER_DATA parsing */ }

    // Next.js / SSR sites: window.__NEXT_DATA__.props.pageProps
    try {
      const nextData = window.__NEXT_DATA__;
      if (nextData && nextData.props) {
        const pageProps = nextData.props.pageProps || nextData.props;
        if (pageProps) {
          const scanObject = (obj, depth = 0) => {
            if (depth > 4 || !obj || typeof obj !== 'object') return;
            // Look for video/image URLs in common patterns
            for (const key of ['videoUrl', 'video_url', 'src', 'url', 'playUrl', 'play_url', 'mediaUrl']) {
              const val = obj[key];
              if (typeof val === 'string' && val.startsWith('http')) {
                const type = classifyByUrl(val);
                if (type) results.push({ url: val, type, name: obj.title || obj.name || '' });
              }
            }
            // Check og/twitter meta for video content
            if (obj['og:video'] || obj['twitter:video']) {
              const url = obj['og:video'] || obj['twitter:video'];
              if (typeof url === 'string' && classifyByUrl(url)) {
                results.push({ url, type: 'video', name: obj['og:title'] || obj.title || '' });
              }
            }
          };
          scanObject(pageProps);
        }
      }
    } catch (e) { /* __NEXT_DATA__ parsing */ }

    // Detect HLS.js streams by patching Hls.loadSource
    if (typeof Hls !== 'undefined' && typeof Hls.prototype?.loadSource === 'function') {
      document.querySelectorAll('video').forEach(video => {
        // hls.js instances attach to video elements; check the video for hls attr
        if (video.dataset.hls || video.dataset.hlsInstanceId) {
          // Already handled - most hls.js instances report .m3u8 via webRequest
        }
      });
    }

    // Process results (dedup + retroactive name update)
    const seen = new Set();
    for (const r of results) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      // Always report new resource with name and optional groupId
      reportResource(r.url, r.type, {
        name: r.name || '',
        groupId: r.groupId || ''
      });
    }
    // Retroactively update names for resources already detected via webRequest
    // that the background might have stored with a URL-derived name.
    // We batch these as a single message after scan completes.
    const nameUpdates = results.filter(r => r.name && r.name.trim().length > 2);
    if (nameUpdates.length > 0) {
      // Use a short timeout to let the report_resource messages flush first
      setTimeout(() => {
        for (const r of nameUpdates) {
          try {
            chrome.runtime.sendMessage({
              action: 'update_resource_name',
              url: r.url,
              name: r.name.trim()
            }).catch(() => {});
          } catch (e) { /* ignore */ }
        }
      }, 100);
    }
  }

  // Initial scan on document idle
  if (document.readyState === 'complete') {
    scanDOM();
  } else {
    document.addEventListener('DOMContentLoaded', scanDOM);
    window.addEventListener('load', scanDOM);
  }

  // Periodic re-scan
  scanTimer = setInterval(scanDOM, SCAN_INTERVAL);

  // ---- MutationObserver for dynamic elements ----

  try {
    observer = new MutationObserver((mutations) => {
      let needsScan = false;
      for (const mutation of mutations) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === 1) {
              const tag = node.tagName?.toLowerCase();
              // Direct media elements or containers
              if (['img', 'video', 'audio', 'source'].includes(tag) ||
                  node.querySelector?.('img, video, audio, source, [data-src], [data-url]')) {
                needsScan = true;
                break;
              }
              // Elements with href/data-* pointing to media
              const attr = node.getAttribute?.('href') || node.getAttribute?.('data-src') ||
                           node.getAttribute?.('data-url') || node.getAttribute?.('data-video');
              if (attr && /\.(png|jpg|jpeg|webp|gif|mp4|webm|m3u8|mp3|m4s|ts)\b/i.test(attr)) {
                needsScan = true;
                break;
              }
              // Bilibili/dynamic site video containers
              if (node.classList?.contains?.('video-container') ||
                  node.classList?.contains?.('player-container') ||
                  node.id?.toLowerCase().includes('player') ||
                  node.id?.toLowerCase().includes('video')) {
                needsScan = true;
                break;
              }
            }
          }
        }
        if (needsScan) break;
      }
      if (needsScan) {
        setTimeout(scanDOM, 100);
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  } catch (e) { /* MutationObserver not available */ }

  // ---- IntersectionObserver for scroll-based video detection ----
  // When a video scrolls into view (Douyin feed), extract its name from nearby elements.

  let scrollObserver = null;
  let scrollObserverReady = false;  // true after initial observation flood settles

  function setupScrollObserver() {
    if (scrollObserver) scrollObserver.disconnect();
    const videos = document.querySelectorAll('video');
    if (videos.length === 0) {
      // Retry after a short delay — videos may not be in DOM yet
      setTimeout(setupScrollObserver, 2000);
      return;
    }
    scrollObserver = new IntersectionObserver((entries) => {
      // Skip the initial flood of already-visible videos
      if (!scrollObserverReady) return;
      let needsScan = false;
      for (const entry of entries) {
        if (entry.isIntersecting) {
          // This video just became visible — try to re-derive its name
          const video = entry.target;
          const name = deriveName(video, video.src || '');
          if (name && name.length > 2) {
            // Check if this video's URL is already reported with a weak name
            const urls = [];
            if (video.src && !video.src.startsWith('blob:') && !video.src.startsWith('data:')) {
              urls.push(normalizedUrl(video.src));
            }
            const dataSrc = video.dataset.src || video.dataset.url || video.getAttribute('data-video-src');
            if (dataSrc && !dataSrc.startsWith('blob:')) urls.push(normalizedUrl(dataSrc));
            // For each URL, send a targeted name update
            for (const vUrl of urls) {
              try {
            chrome.runtime.sendMessage({
              action: 'update_resource_name',
              url: vUrl,
              name: name
            }).catch(() => {});
          } catch (e) { /* ignore */ }
            }
          }
          // Also trigger a full scan to pick up any new resources
          needsScan = true;
        }
      }
      if (needsScan) setTimeout(scanDOM, 50);
    }, { threshold: 0.3 });

    videos.forEach(v => scrollObserver.observe(v));
  }

  // Initial setup + re-setup on each scan (new videos added to DOM)
  const origScan = scanDOM;
  scanDOM = function () {
    origScan();
    // Re-observe any new video elements
    if (scrollObserver) {
      document.querySelectorAll('video').forEach(v => scrollObserver.observe(v));
    }
  };

  // Start observer after a short delay to let initial videos load.
  // The ready flag is set after the initial observation (already-visible videos) settles.
  setTimeout(() => {
    setupScrollObserver();
    setTimeout(() => { scrollObserverReady = true; }, 500);
  }, 1000);

  // ---- HLS.js / dash.js stream detection ----

  // Patch Hls.loadSource to capture stream URLs
  if (typeof Hls !== 'undefined' && Hls.prototype?.loadSource) {
    const origLoad = Hls.prototype.loadSource;
    Hls.prototype.loadSource = function (url) {
      reportResource(url, 'stream', { initiator: location.href });
      return origLoad.call(this, url);
    };
  }

  // ---- Tab sniffing toggle (from popup) ----

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'setSniffing') {
      sniffingEnabled = message.enabled;
      if (sniffingEnabled) {
        // Resume: restart periodic scan, reconnect observer, flush any pending
        scanTimer = setInterval(scanDOM, SCAN_INTERVAL);
        if (observer) {
          observer.observe(document.documentElement, {
            childList: true,
            subtree: true
          });
        }
        scanDOM();
      } else {
        // Pause: stop timers, disconnect observer, clear pending batch
        if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
        if (observer) { observer.disconnect(); }
        if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
        pendingBatch.clear();
      }
      sendResponse({ ok: true });
    }
    return true; // keep channel open for async
  });

  // ---- Expose API for popup ----

  window.__resFind = {
    scanNow: scanDOM,
    getResources: () => Array.from(pendingBatch.values())
  };

  // Flush any remaining on page unload
  window.addEventListener('beforeunload', () => {
    if (extensionInvalidated) return;
    flushBatch();
    if (scanTimer) clearInterval(scanTimer);
    if (observer) observer.disconnect();
  });

  // Also flush periodically to avoid stale batch
  setInterval(flushBatch, 2000);
})();

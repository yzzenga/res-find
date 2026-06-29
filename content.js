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

  // ---- Helpers ----

  function classifyByUrl(url) {
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) return null;
    const u = url.split('?')[0].split('#')[0];
    if (/\.(m3u8|mpd)\b/i.test(u)) return 'stream';
    if (/\.(png|jpe?g|gif|webp|avif|bmp|svg|ico|tiff?)\b/i.test(u)) return 'image';
    if (/\.(mp4|webm|ogg|mov|avi|mkv|flv|wmv|m4v|3gp)\b/i.test(u)) return 'video';
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

  function reportResource(url, type, extra) {
    const normalized = normalizedUrl(url);
    if (pendingBatch.has(normalized)) return;
    pendingBatch.set(normalized, {
      url: normalized,
      type: type || classifyByUrl(url) || 'unknown',
      pageUrl: location.href,
      contentType: extra?.contentType || '',
      size: extra?.size || -1,
      initiator: extra?.initiator || location.href
    });
    scheduleFlush();
  }

  function scheduleFlush() {
    if (batchTimer) clearTimeout(batchTimer);
    batchTimer = setTimeout(flushBatch, BATCH_DEBOUNCE);
  }

  function flushBatch() {
    batchTimer = null;
    if (pendingBatch.size === 0) return;
    const entries = Array.from(pendingBatch.values());
    pendingBatch.clear();
    for (const entry of entries) {
      try {
        chrome.runtime.sendMessage({ action: 'report_resource', ...entry });
      } catch (e) {
        // extension context may have been invalidated
      }
    }
  }

  // ---- PerformanceObserver ----

  try {
    const perfObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const type = classifyByUrl(entry.name);
        if (type) {
          reportResource(entry.name, type, {
            initiator: entry.initiatorType || ''
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
        reportResource(entry.name, type, {
          initiator: entry.initiatorType || ''
        });
      }
    });
  } catch (e) { /* ignore */ }

  // ---- DOM scanning ----

  function scanDOM() {
    const results = [];

    // Images
    document.querySelectorAll('img').forEach(img => {
      if (img.src && !img.src.startsWith('data:')) {
        const type = classifyByUrl(img.src);
        if (type) results.push({ url: img.src, type });
      }
      if (img.srcset) {
        img.srcset.split(',').forEach(part => {
          const match = part.trim().match(/^(\S+)/);
          if (match) {
            const url = normalizedUrl(match[1]);
            const type = classifyByUrl(url);
            if (type) results.push({ url, type });
          }
        });
      }
    });

    // Videos & streams
    document.querySelectorAll('video').forEach(video => {
      if (video.src) {
        const url = normalizedUrl(video.src);
        const type = classifyByUrl(url) || 'video';
        results.push({ url, type });
      }
      video.querySelectorAll('source').forEach(source => {
        if (source.src) {
          const url = normalizedUrl(source.src);
          const type = classifyByUrl(url) || 'video';
          results.push({ url, type });
        }
      });
      // Check for MediaSource / blob URL
      if (video.src && video.src.startsWith('blob:')) {
        // Cannot directly capture the stream URL from blob, but note it
      }
    });

    // Audio
    document.querySelectorAll('audio').forEach(audio => {
      if (audio.src) {
        const url = normalizedUrl(audio.src);
        const type = classifyByUrl(url) || 'audio';
        results.push({ url, type });
      }
      audio.querySelectorAll('source').forEach(source => {
        if (source.src) {
          const url = normalizedUrl(source.src);
          const type = classifyByUrl(url) || 'audio';
          results.push({ url, type });
        }
      });
    });

    // Links to media files (direct media URLs)
    document.querySelectorAll('a[href]').forEach(a => {
      const type = classifyByUrl(a.href);
      if (type) results.push({ url: a.href, type });
    });

    // Detect HLS.js streams by patching Hls.loadSource
    if (typeof Hls !== 'undefined' && typeof Hls.prototype?.loadSource === 'function') {
      document.querySelectorAll('video').forEach(video => {
        // hls.js instances attach to video elements; check the video for hls attr
        if (video.dataset.hls || video.dataset.hlsInstanceId) {
          // Already handled - most hls.js instances report .m3u8 via webRequest
        }
      });
    }

    // Process results (dedup)
    const seen = new Set();
    for (const r of results) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      reportResource(r.url, r.type);
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
              if (['img', 'video', 'audio', 'source'].includes(tag) ||
                  node.querySelector?.('img, video, audio, source') ||
                  node.nodeType === 1 && node.getAttribute?.('href')?.match?.(/\.(png|jpg|jpeg|webp|mp4|mp3|m3u8)/i)) {
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

  // ---- HLS.js / dash.js stream detection ----

  // Patch Hls.loadSource to capture stream URLs
  if (typeof Hls !== 'undefined' && Hls.prototype?.loadSource) {
    const origLoad = Hls.prototype.loadSource;
    Hls.prototype.loadSource = function (url) {
      reportResource(url, 'stream', { initiator: location.href });
      return origLoad.call(this, url);
    };
  }

  // ---- Expose API for popup ----

  window.__resFind = {
    scanNow: scanDOM,
    getResources: () => Array.from(pendingBatch.values())
  };

  // Flush any remaining on page unload
  window.addEventListener('beforeunload', () => {
    flushBatch();
    if (scanTimer) clearInterval(scanTimer);
    if (observer) observer.disconnect();
  });

  // Also flush periodically to avoid stale batch
  setInterval(flushBatch, 2000);
})();

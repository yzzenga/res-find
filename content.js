/**
 * Res-Find Content Script
 * ========================
 * 注入到每个页面中的内容脚本，负责：
 * 1. 注入 MAIN World 的 Hook 脚本（injected.js）
 * 2. 通过 PerformanceObserver 嗅探已加载的资源
 * 3. 通过 DOM 扫描（scanDOM）发现页面中的媒体元素
 * 4. 通过 MutationObserver 监控动态添加的媒体元素
 * 5. 通过 IntersectionObserver 处理懒加载视频（如抖音）
 * 6. 识别特定站点（B站、抖音）的全局数据结构提取资源
 *
 * 与 Background Service Worker 通过 chrome.runtime.sendMessage 通信，
 * 与 Injected Hook 脚本通过 window.postMessage 通信。
 */

(function () {
  'use strict';

  if (window.__resFindInjected) return;
  window.__resFindInjected = true;

  // --- 注入 MAIN World 的 Hook 脚本 ---
  // 必须在页面加载早期执行，以拦截 JS 层面的 API 调用
  (function injectHook() {
    try {
      var s = document.createElement('script');
      s.src = chrome.runtime.getURL('injected.js');
      s.onload = function () { s.remove(); };
      (document.head || document.documentElement).appendChild(s);
    } catch (e) { /* 注入失败 */ }
  })();

  const SCAN_INTERVAL = 3000;     // 每 3 秒进行一次全 DOM 扫描
  const BATCH_DEBOUNCE = 500;     // 批量报告资源的防抖间隔（毫秒）
  const STREAM_KEYWORDS = /m3u8|mpd|\.ts\b|segment|chunklist|manifest/i;

  let pendingBatch = new Map();    // 待批处理发送的资源集合 url -> { url, type, ... }
  let batchTimer = null;           // 批处理计时器
  let scanTimer = null;            // 周期扫描计时器
  let observer = null;             // MutationObserver 实例
  let sniffingEnabled = true;      // 由 Popup 的嗅探开关控制
  let extensionInvalidated = false; // chrome.runtime 断开时设为 true

  /**
   * 扩展上下文失效处理
   * 当 chrome.runtime 断开时，设置失效标志并清除批处理计时器。
   * 不再调用任何扩展 API，但页面定时器/观察者保持存活，
   * 页面刷新或导航后自然清理。
   */
  function handleInvalidated() {
    if (extensionInvalidated) return;
    extensionInvalidated = true;
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
  }

  // ========== 工具函数 ==========

  /**
   * 仅通过 URL 判断资源类型（无需 Content-Type）
   * 注意：比 background.js 中的 classifyResource 少了 Content-Type 参数
   */
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

  /** 标准化 URL：解析为绝对路径并去除片段标识（#） */
  function normalizedUrl(url) {
    try {
      const u = new URL(url, location.href);
      return u.href.split('#')[0];
    } catch { return url; }
  }

  /**
   * 判断名称是否为"好"的（人类可读的标题，而非自动生成的哈希/URL）
   * 用于筛选页面中提取的名称，避免使用无意义的文件名
   */
  function isGoodName(name) {
    if (!name || name.length < 3 || name.length > 200) return false;
    if (/^[a-f0-9]{16,}$/i.test(name)) return false;  // 纯十六进制哈希
    if (/^[a-zA-Z0-9]{24,}$/.test(name)) return false; // 长随机字符串
    if (!/[\u4e00-\u9fff\w]/.test(name)) return false; // 必须包含中文字符或单词字符
    return true;
  }

  /**
   * 向后台发送资源报告（带防抖批量处理）
   * 同一 URL 在短时间内多次报告会合并更新
   * @param {string} url - 资源 URL
   * @param {string} type - 资源类型
   * @param {Object} extra - 额外信息（名称、分组ID等）
   */
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

  /**
   * 从媒体元素的 DOM 上下文推断人类可读的名称
   * 优先级链：
   *   title > alt > aria-label > data-* > 父级链接文本 > figcaption > 标题元素 > 卡片布局
   */
  function deriveName(element, url) {
    // 优先级 1：元素自身属性
    let name = element.getAttribute('title')
      || element.getAttribute('alt')
      || element.getAttribute('aria-label')
      || element.dataset.title
      || element.dataset.name
      || element.getAttribute('name');
    if (name && name.trim().length > 0 && name.trim().length < 150) {
      return name.trim();
    }
    // 优先级 2：图片特有——检查父级链接、figcaption、标题
    if (element.tagName === 'IMG') {
      const parent = element.parentElement;
      if (parent) {
        // <a><img></a> 模式 → 使用链接文本或 title
        if (parent.tagName === 'A') {
          if (parent.title && parent.title.trim().length > 0) return parent.title.trim();
          const aText = parent.textContent.trim();
          if (aText && aText.length > 1 && aText.length < 120) return aText;
        }
        // <figure><img><figcaption>caption</figcaption></figure> 模式
        const figcaption = parent.querySelector('figcaption');
        if (figcaption && figcaption.textContent.trim().length > 0) {
          return figcaption.textContent.trim().slice(0, 150);
        }
        // 检查同级标题元素或父级标题
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

  /**
   * 为视频/音频元素深度提取名称（相对于图片有更复杂的 DOM 结构）
   * 尝试多种策略逐步降级：
   *   poster > figcaption > 前一个兄弟元素 > 父级 aria-label >
   *   标题样式元素 > 父容器兄弟 > 卡片布局遍历 > JSON-LD > URL 路径
   */
  function deriveVideoName(element, url) {
    // 策略 1：从 poster 属性提取可读名称
    if (element.tagName === 'VIDEO' && element.poster) {
      const pName = decodeURIComponent(element.poster.split('/').pop()?.split('?')[0] || '')
        .replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
      if (pName && pName.length > 3 && pName.length < 100) return pName;
    }

    // 策略 2：检查 <figure> + <figcaption> —— 最精确的媒体容器
    const figure = element.closest('figure');
    if (figure) {
      const figCaption = figure.querySelector('figcaption');
      if (figCaption && figCaption.textContent.trim().length > 0) {
        return figCaption.textContent.trim().slice(0, 150);
      }
    }

    // 策略 3：检查前一个兄弟元素（标题通常紧挨在视频上方）
    const prev = element.previousElementSibling;
    if (prev) {
      const t = prev.textContent.trim();
      if (t && t.length > 3 && t.length < 200) return t;
    }

    // 策略 4：向上遍历 4 层父元素，查找 aria-label 或标题样式子元素
    let el = element.parentElement;
    for (let depth = 0; depth < 4 && el; depth++) {
      const label = el.getAttribute('aria-label') || el.getAttribute('title');
      if (label && label.trim().length > 2 && label.trim().length < 200) {
        return label.trim();
      }
      // 查找类名包含 title/heading/headline/name 的子元素（跳过页面主标题 h1）
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

    // 策略 5：检查父容器的前一个兄弟元素
    if (element.parentElement) {
      const parentSibling = element.parentElement.previousElementSibling;
      if (parentSibling) {
        const t = parentSibling.textContent.trim();
        if (t && t.length > 5 && t.length < 200) return t;
      }
    }

    // 策略 6：卡片式布局遍历（适配抖音、B站等信息流）
    // 向上走 6 层，查找标题/描述元素
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

    // 策略 7：检查 JSON-LD 结构化数据（适用于任何有 Schema.org 标记的页面）
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
    } catch (e) { /* JSON-LD 解析错误 */ }

    // 策略 8：从 URL 路径提取文件名作为最终兜底
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

  /**
   * 反向 DOM 查找：根据资源 URL 找到对应的 DOM 元素
   * 用于从 PerformanceObserver 捕获的资源 URL 回溯到页面元素，
   * 从而提取 alt/title 等属性作为文件名
   * @param {string} resourceUrl - 资源 URL
   * @returns {Element|null} 找到的 DOM 元素，未找到则返回 null
   */
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

  /**
   * 从页面 <meta> 标签中查找与资源 URL 对应的名称
   * 例如 og:image 对应 og:title，twitter:image 对应 twitter:title
   * @param {string} resourceUrl - 资源 URL
   * @returns {string} 找到的名称，未找到则返回空字符串
   */
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

  // ========== PerformanceObserver 监听 ==========
  // 监听浏览器性能 API，捕获页面加载过程中的所有资源请求
  // 注意：此处只能通过 URL 判断名称，后续 scanDOM 会通过 DOM 回溯更新更好名称

  try {
    const perfObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const type = classifyByUrl(entry.name);
        if (type) {
          // 尝试通过 URL 反向查找 DOM 元素，提取更有意义的名称
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
  } catch (e) { /* PerformanceObserver 不被支持 */ }

  // 捕获 PerformanceObserver 注册前已有的性能条目
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

  // ========== DOM 扫描 ==========
  // 遍历页面 DOM 树，查找所有媒体元素并提取名称

  function scanDOM() {
    if (extensionInvalidated) return;
    const results = [];

    // --- 扫描图片元素 ---
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

    // --- 扫描视频元素（含 data-src/data-url 懒加载视频） ---
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

    // --- 扫描音频元素 ---
    document.querySelectorAll('audio').forEach(audio => {
      const aName = deriveName(audio, audio.src);
      if (audio.src) {
        const url = normalizedUrl(audio.src);
        const type = classifyByUrl(url) || 'audio';
        results.push({ url, type, name: aName });
      }
      // Check data-src/data-url/data-audio-src for lazy-loaded audio (common in SPA players)
      const dataSrc = audio.dataset.src || audio.dataset.url || audio.getAttribute('data-audio-src');
      if (dataSrc && !dataSrc.startsWith('blob:') && !dataSrc.startsWith('data:')) {
        const url = normalizedUrl(dataSrc);
        if (url !== audio.src) {
          const type = classifyByUrl(url) || 'audio';
          results.push({ url, type, name: aName || dataSrc });
        }
      }
      audio.querySelectorAll('source').forEach(source => {
        if (source.src) {
          const url = normalizedUrl(source.src);
          const type = classifyByUrl(url) || 'audio';
          results.push({ url, type, name: source.getAttribute('title') || aName });
        }
      });
    });

    // --- 扫描指向媒体文件的链接（直接链接到图片/视频/音频的 <a> 标签） ---
    document.querySelectorAll('a[href]').forEach(a => {
      const type = classifyByUrl(a.href);
      if (type) results.push({ url: a.href, type, name: a.title || a.textContent.trim().slice(0, 100) });
    });

    // ========== 特定站点全局数据提取 ==========
    // 从知名站点的全局 JS 变量中直接提取视频/音频 URL
    // 这些变量在页面加载时已经包含完整的媒体信息

    // ---- Bilibili（B站）：window.__INITIAL_STATE__ 包含完整视频信息 ----
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

    // ---- 抖音：window._ROUTER_DATA.loaderData 包含视频元数据和 URL ----
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

    // ---- Next.js / SSR 站点：window.__NEXT_DATA__.props.pageProps ----
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

  // ========== MutationObserver 动态元素监听 ==========
  // 监控 DOM 变化，捕获通过 JS 动态添加到页面的媒体元素

  function handleSrcMutation(target) {
    var tag = target.tagName?.toLowerCase();
    if (!['audio', 'video', 'source'].includes(tag)) return;
    var url = target.currentSrc || target.src || target.getAttribute('src');
    if (url && !url.startsWith('blob:') && !url.startsWith('data:') && url.length > 5) {
      var type = classifyByUrl(url) || (tag === 'audio' ? 'audio' : 'video');
      reportResource(url, type, { name: deriveName(target, url) });
    }
  }

  try {
    observer = new MutationObserver(function (mutations) {
      var needsScan = false;
      for (var m = 0; m < mutations.length; m++) {
        var mutation = mutations[m];
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          for (var n = 0; n < mutation.addedNodes.length; n++) {
            var node = mutation.addedNodes[n];
            if (node.nodeType === 1) {
              var tag = node.tagName?.toLowerCase();
              // Direct media elements or containers
              if (['img', 'video', 'audio', 'source'].includes(tag) ||
                  node.querySelector?.('img, video, audio, source, [data-src], [data-url]')) {
                needsScan = true;
                break;
              }
              // Elements with href/data-* pointing to media
              var attr = node.getAttribute?.('href') || node.getAttribute?.('data-src') ||
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
        // Detect src/data-src attribute changes on existing media elements
        if (mutation.type === 'attributes') {
          var t = mutation.target;
          var tTag = t.tagName?.toLowerCase();
          if (['audio', 'video', 'source'].includes(tTag)) {
            if (mutation.attributeName === 'src') {
              handleSrcMutation(t);
            } else {
              // data-src / data-url change -> trigger full scan
              needsScan = true;
            }
          } else if (['data-src', 'data-url'].indexOf(mutation.attributeName) !== -1) {
            // Non-media element getting data-src -> might be lazy-loading a media container
            needsScan = true;
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
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'data-src', 'data-url']
    });
  } catch (e) { /* MutationObserver not available */ }

  // ========== IntersectionObserver 滚动懒加载检测 ==========
  // 当视频滚动到视口内时，获取附近元素的名称信息
  // 主要用于抖音等无限滚动 feed 场景

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

  // ========== HLS.js / dash.js 流媒体检测 ==========
  // 通过 Monkey-patch Hls.loadSource 捕获 HLS 流 URL
  if (typeof Hls !== 'undefined' && Hls.prototype?.loadSource) {
    const origLoad = Hls.prototype.loadSource;
    Hls.prototype.loadSource = function (url) {
      reportResource(url, 'stream', { initiator: location.href });
      return origLoad.call(this, url);
    };
  }

  // ========== 嗅探开关控制（来自 Popup） ==========

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'setSniffing') {
      sniffingEnabled = message.enabled;
      if (sniffingEnabled) {
        // Resume: restart periodic scan, reconnect observer, flush any pending
        scanTimer = setInterval(scanDOM, SCAN_INTERVAL);
        if (observer) {
          observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src', 'data-src', 'data-url']
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

  // ========== 与 injected.js（MAIN World Hook）通信 ==========
  // 通过 window.postMessage 接收 Hook 脚本捕获的媒体 URL

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== '__resFind_hook') return;

    var type = event.data.type;
    var url = event.data.url;
    if (!url && type !== 'mseCreated') return;

    switch (type) {
      case 'mediaSrc':
      case 'audioCtor':
        reportResource(url, classifyByUrl(url) || (event.data.tag === 'AUDIO' ? 'audio' : 'video'), {
          name: '',
          initiator: location.href
        });
        break;
      case 'apiExtract':
        reportResource(url, classifyByUrl(url) || 'audio', {
          name: '',
          initiator: location.href
        });
        break;
      case 'mseCreated':
        // MSE stream detected — the player element should appear soon
        setTimeout(scanDOM, 100);
        break;
    }
  });

  // ========== 暴露 API 给 Popup（调试/手动调用） ==========

  window.__resFind = {
    scanNow: scanDOM,
    getResources: () => Array.from(pendingBatch.values())
  };

  // 页面卸载前刷新所有待处理的资源报告
  window.addEventListener('beforeunload', () => {
    if (extensionInvalidated) return;
    flushBatch();
    if (scanTimer) clearInterval(scanTimer);
    if (observer) observer.disconnect();
  });

  // Also flush periodically to avoid stale batch
  setInterval(flushBatch, 2000);
})();

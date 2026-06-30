/**
 * Res-Find 后台 Service Worker
 * ============================
 * 核心功能：
 * 1. 管理所有标签页的资源存储（去重、元数据）
 * 2. 通过 webRequest API 嗅探网络请求中的媒体资源
 * 3. 处理来自 Content Script 和 Popup 的消息
 * 4. 编排文件下载和音视频合成流程
 *
 * 架构说明：
 * - tabResources（Set）：存储已发现的资源 URL，用于快速去重
 * - tabResourceMeta（Map）：存储资源的完整元数据（类型、格式、文件名等）
 * - disabledTabs（Set）：记录用户手动关闭嗅探的标签页
 */

importScripts('shared.js');

const tabResources = new Map();       // tabId -> Set<url>（URL 去重集合）
const tabResourceMeta = new Map();    // tabId -> Map<url, ResourceMeta>（完整资源元数据）
const disabledTabs = new Set();       // tabId -> 该标签页已禁用嗅探

const RESOURCE_TTL = 15 * 60 * 1000;  // 资源缓存有效期：15 分钟

// ========== 资源分类 ==========

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico|tiff?)\b/i;
const VIDEO_EXT = /\.(mp4|webm|ogg|mov|avi|mkv|flv|wmv|m4v|3gp|m4s|ts)\b/i;
const AUDIO_EXT = /\.(mp3|wav|flac|aac|ogg|wma|m4a|opus|aiff)\b/i;
const STREAM_PATTERN = /\.(m3u8|mpd)\b/i;
const STREAM_KEYWORD = /m3u8|mpd|manifest|playlist|chunklist|segment|media\.ts/i;
const IMAGE_CONTENT = /^image\//;
const VIDEO_CONTENT = /^video\//;
const AUDIO_CONTENT = /^audio\//;
const STREAM_CONTENT = /application\/(x-mpegurl|vnd\.apple\.mpegurl|dash\+xml)|text\/uri-list/i;

/**
 * 根据 URL 和 Content-Type 判断资源类型
 * @param {string} url - 资源 URL
 * @param {string} contentType - HTTP Content-Type 头
 * @returns {string|null} 'stream' | 'video' | 'audio' | 'image' | null
 */
function classifyResource(url, contentType) {
  if (STREAM_PATTERN.test(url) || STREAM_CONTENT.test(contentType) || STREAM_KEYWORD.test(url)) {
    return 'stream';
  }
  if (VIDEO_EXT.test(url) || VIDEO_CONTENT.test(contentType)) return 'video';
  if (AUDIO_EXT.test(url) || AUDIO_CONTENT.test(contentType)) return 'audio';
  if (IMAGE_EXT.test(url) || IMAGE_CONTENT.test(contentType)) return 'image';
  return null; // 无法识别的资源类型
}

// ========== 资源存储 ==========

// guessFormat、tryGetExtension、looksLikeRandomHash、formatSize、cleanUrl
// 由 shared.js 通过 importScripts 提供

/**
 * 智能生成文件名的核心函数
 * 优先级：content script 提供的显式名称 > URL 查询参数中的文件名 > URL 路径最后一段 > 域名+上下文
 */

function getFilename(url, type, nameHint) {
  // 优先级 1：使用 content script 从 DOM 中提取的显式名称（alt/title 等属性）
  if (nameHint && nameHint.length > 2 && nameHint.length < 200 && !looksLikeRandomHash(nameHint)) {
    // 清理：去除首尾空格、移除文件名中不允许的字符
    let clean = nameHint.trim()
      .replace(/[<>:"\/\\|?*\x00-\x1f]/g, '')
      .replace(/\s+/g, ' ');
    // 如果名称没有扩展名但 URL 有，则自动补上
    if (clean.length > 0 && clean.length < 150) {
      const urlExt = tryGetExtension(url);
      if (urlExt && !clean.toLowerCase().endsWith('.' + urlExt)) {
        clean += '.' + urlExt;
      }
      return clean;
    }
  }
  // 优先级 2：从 URL 路径中提取
  try {
    const u = new URL(url);
    const raw = decodeURIComponent(u.pathname);
    const segments = raw.split('/').filter(Boolean);

    // 检查 URL 查询参数中是否包含有意义的文件名（许多 CDN URL 使用此模式）
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
        // 文件名是哈希值，尝试用上一级路径作为上下文前缀
        if (segments.length > 1) {
          const prev = decodeURIComponent(segments[segments.length - 2]);
          if (prev && prev.length > 1 && prev.length < 60 && !looksLikeRandomHash(prev)) {
            const ext = tryGetExtension(url);
            return ext ? `${prev}_${type}.${ext}` : `${prev}_${type}`;
          }
        }
        // 哈希值无法处理，继续降级到域名+类型
      } else {
        if (name.length < 200) return name;
      }
    }
    // 优先级 3：使用域名 + 路径上下文 + 类型组合（保证文件名唯一性）
    const domain = u.hostname.replace(/^www\./, '').replace(/[^a-zA-Z0-9]/g, '_');
    const ext = tryGetExtension(url);
    // 取最多 2 个有意义的路径片段作为上下文，防止哈希值路径导致文件名混乱
    const context = segments
      .slice(0, -1)
      .map(s => decodeURIComponent(s))
      .filter(s => s && s.length > 1 && !looksLikeRandomHash(s))
      .slice(-2)
      .join('_');
    if (context) {
      return ext ? `${domain}_${context}_${type}.${ext}` : `${domain}_${context}_${type}`;
    }
    // 最终兜底：从 URL 末尾截取一段特征字符，避免完全重复
    const urlTag = url.replace(/[?#].*/, '').slice(-12).replace(/[^a-zA-Z0-9]/g, '');
    return ext
      ? `${domain}_${type}_${urlTag}.${ext}`
      : `${domain}_${type}_${urlTag}`;
  } catch {
    return `${type}`;
  }
}

/**
 * URL 归一化：移除 range/chunk/part 等分片查询参数
 * 防止同一个资源因分片请求被重复记录
 * @param {string} rawUrl - 原始 URL
 * @returns {string} 归一化后的 URL
 */
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

/**
 * 添加资源到存储中（含去重和智能更新）
 * 如果 URL 已存在但 content script 提供了更好的名称，则更新名称
 * @param {number} tabId - 标签页 ID
 * @param {string} rawUrl - 原始 URL
 * @param {string} type - 资源类型
 * @param {Object} metadata - 元数据（名称、大小、Content-Type 等）
 */
function addResource(tabId, rawUrl, type, metadata) {
  if (disabledTabs.has(tabId)) return;
  const url = normalizeResourceUrl(rawUrl);
  if (!url || url.startsWith('data:') || url.startsWith('blob:chrome-extension')) return;
  if (!tabResources.has(tabId)) {
    tabResources.set(tabId, new Set());
    tabResourceMeta.set(tabId, new Map());
  }
  const meta = tabResourceMeta.get(tabId);

  // URL 已存在——检查 content script 是否识别出了更好的名称（如从 alt/title 属性提取的）
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
    detectedAt: Date.now(),           // 发现时间，用于过期清理
    pageUrl: metadata.pageUrl || '',
    size: metadata.size || -1,
    sizeFormatted: formatSize(metadata.size),
    contentType: metadata.contentType || '',
    initiator: metadata.initiator || '',
    name: metadata.name || filename,  // 优先使用 DOM 中提取的名称
    groupId: metadata.groupId || '',  // 配对分组 ID（用于音视频合成配对）
    tabId
  };
  meta.set(url, entry);
}

/** 获取指定标签页的所有资源列表 */
function getResourcesForTab(tabId) {
  const meta = tabResourceMeta.get(tabId);
  return meta ? Array.from(meta.values()) : [];
}

/** 清空指定标签页的资源缓存 */
function clearTabResources(tabId) {
  tabResources.delete(tabId);
  tabResourceMeta.delete(tabId);
}

/** 清理过期资源（超过 RESOURCE_TTL 的条目自动移除） */
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
// 每分钟执行一次过期清理
setInterval(clearExpired, 60 * 1000);

// ========== webRequest 监听 ==========
// 通过拦截浏览器网络请求，自动嗅探页面加载的媒体资源

const pendingRequests = new Map(); // requestId -> { url, tabId, initiator }

/**
 * 请求发起前拦截：首先根据 URL 初步判断资源类型并记录，
 * 同时保存请求信息，等待响应完成后获取完整的 Content-Type 和大小
 */
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

/**
 * 请求完成后回调：获取 Content-Type 和 Content-Length 完善资源元数据
 * 此时可以更准确地判断资源类型（基于 MIME 而非仅 URL 后缀）
 */
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

/** 请求失败时清理 pending 记录 */
chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    pendingRequests.delete(details.requestId);
  },
  { urls: ['<all_urls>'] }
);

// ========== 标签页生命周期管理 ==========

/** 标签页关闭时自动清理该页面的资源缓存和挂起的请求 */
chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabResources(tabId);
  disabledTabs.delete(tabId);
  // 清理该标签页仍在进行中的网络请求记录，防止内存泄漏
  for (const [reqId, req] of pendingRequests) {
    if (req.tabId === tabId) pendingRequests.delete(reqId);
  }
});

// ========== 消息处理 ==========
// 处理来自 Content Script 和 Popup 的所有通信

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    /** content script 报告发现新资源 */
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

    /** content script 扫描 DOM 后为已有资源补充更好的名称 */
    case 'update_resource_name': {
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

    /** 用户手动重命名资源 */
    case 'rename_resource': {
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

    /** 用户手动修改资源类型（如将视频识别为音频） */
    case 'change_resource_type': {
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

    /** 启动音视频合成下载：先分别下载 video/audio 流，再打开合成页面 */
    case 'merge_download': {
      const { videoUrl, audioUrl, baseName, tabId: msgTabId } = message;
      const tid = sender.tab?.id || msgTabId;
      // 从 URL 推断实际扩展名，避免所有音频被强制命名为 .mp4
      const videoExt = tryGetExtension(videoUrl) || 'mp4';
      const audioExt = tryGetExtension(audioUrl) || 'mp4';
      chrome.downloads.download({
        url: videoUrl,
        filename: baseName + '_video.' + videoExt,
        conflictAction: 'uniquify'
      }).catch(function (err) {
        console.error('视频下载失败:', err);
      });
      chrome.downloads.download({
        url: audioUrl,
        filename: baseName + '_audio.' + audioExt,
        conflictAction: 'uniquify'
      }).catch(function (err) {
        console.error('音频下载失败:', err);
      });
      // 打开合成工具页面（浏览器端使用 MediaRecorder 合成）
      const mergeUrl = chrome.runtime.getURL('merge.html')
        + '?video=' + encodeURIComponent(videoUrl)
        + '&audio=' + encodeURIComponent(audioUrl)
        + '&name=' + encodeURIComponent(baseName);
      chrome.tabs.create({ url: mergeUrl, active: false });
      sendResponse({ ok: true });
      break;
    }

    /** Popup 请求获取资源列表 */
    case 'get_resources': {
      const tabId = message.tabId;
      const resources = getResourcesForTab(tabId);
      sendResponse({ resources });
      break;
    }

    /** 清空资源列表 */
    case 'clear_resources': {
      const tabId = message.tabId;
      clearTabResources(tabId);
      sendResponse({ ok: true });
      break;
    }

    /** 下载单个资源文件 */
    case 'download_resource': {
      const { url, filename } = message;
      chrome.downloads.download({
        url,
        filename: filename || undefined,
        conflictAction: 'uniquify',  // 自动重命名避免覆盖
        saveAs: false
      }).catch(err => console.error('下载失败:', err));
      sendResponse({ ok: true });
      break;
    }

    /** 查询标签页的资源数量（用于徽章计数） */
    case 'get_tab_resources_count': {
      const tabId = message.tabId;
      const resources = getResourcesForTab(tabId);
      sendResponse({ count: resources.length });
      break;
    }

    /** 查询指定标签页的嗅探开关状态 */
    case 'get_tab_sniffing_state': {
      const tabId = message.tabId;
      sendResponse({ disabled: disabledTabs.has(tabId) });
      break;
    }

    /** 切换指定标签页的嗅探开关 */
    case 'toggle_tab_sniffing': {
      const tabId = message.tabId;
      if (disabledTabs.has(tabId)) {
        disabledTabs.delete(tabId);
        chrome.tabs.sendMessage(tabId, { action: 'setSniffing', enabled: true }).catch(() => {});
        sendResponse({ disabled: false });
      } else {
        disabledTabs.add(tabId);
        chrome.tabs.sendMessage(tabId, { action: 'setSniffing', enabled: false }).catch(() => {});
        sendResponse({ disabled: true });
      }
      break;
    }
  }
  return true; // 保持消息通道开放以支持异步响应
});

// ========== 扩展安装事件 ==========

chrome.runtime.onInstalled.addListener(() => {
  console.log('Res-Find 已安装，准备嗅探资源。');
});

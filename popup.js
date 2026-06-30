/**
 * Res-Find 弹窗脚本
 * ==================
 * 作为扩展 Popup 的 UI 控制器，负责：
 * 1. 从 Background Service Worker 获取资源列表
 * 2. 渲染资源列表（支持图片/视频/音频/流媒体四种类型）
 * 3. 提供筛选功能（按类型、格式、大小、搜索关键词）
 * 4. 支持单个下载、批量下载、音视频合成下载
 * 5. 资源预览（图片/视频/音频/流媒体）
 * 6. 嗅探开关控制
 * 7. 资源重命名和类型手动修正
 */

(function () {
  'use strict';

  let currentTabId = null;           // 当前标签页 ID
  let allResources = [];             // 所有资源列表
  let filteredResources = [];        // 筛选后的资源列表
  let selectedUrls = new Set();      // 用户勾选的 URL 集合
  let currentFilter = 'all';         // 当前类型筛选
  let currentFormat = 'all';         // 当前格式筛选
  let currentSize = 'all';           // 当前大小筛选
  let searchTerm = '';               // 当前搜索关键词
  let searchTimer = null;            // 搜索防抖计时器
  let tabSniffingDisabled = false;   // 当前标签页嗅探是否禁用

  // DOM 元素缓存
  const els = {
    totalCount: document.getElementById('totalCount'),
    countAll: document.getElementById('countAll'),
    countImage: document.getElementById('countImage'),
    countVideo: document.getElementById('countVideo'),
    countStream: document.getElementById('countStream'),
    countAudio: document.getElementById('countAudio'),
    filters: document.getElementById('filters'),
    formatFilters: document.getElementById('formatFilters'),
    sizeFilters: document.getElementById('sizeFilters'),
    resourceList: document.getElementById('resourceList'),
    scanBtn: document.getElementById('scanNowBtn'),
    downloadSelectedBtn: document.getElementById('downloadSelectedBtn'),
    clearBtn: document.getElementById('clearBtn'),
    statusText: document.getElementById('statusText'),
    retryBtn: document.getElementById('retryBtn'),
    emptyMessage: document.getElementById('emptyMessage'),
    template: document.getElementById('resourceItem'),
    searchInput: document.getElementById('searchInput'),
    searchClear: document.getElementById('searchClear'),
    previewOverlay: document.getElementById('previewOverlay'),
    previewBody: document.getElementById('previewBody'),
    previewName: document.getElementById('previewName'),
    previewClose: document.getElementById('previewClose'),
    previewDownload: document.getElementById('previewDownload'),
    previewUrl: document.getElementById('previewUrl'),
    mergeDownloadBtn: document.getElementById('mergeDownloadBtn'),
    sniffToggle: document.getElementById('sniffToggle'),
    sniffBanner: document.getElementById('sniffBanner'),
  };

  // ========== 工具函数 ==========

  /** 根据资源类型返回徽章标签 */
  function typeBadgeLabel(type) {
    switch (type) {
      case 'image': return 'IMG';
      case 'video': return 'VID';
      case 'stream': return 'STRM';
      case 'audio': return 'AUD';
      default: return type.toUpperCase();
    }
  }

  /** 根据资源类型返回对应的 SVG 图标字符串 */
  function svgIcon(type) {
    switch (type) {
      case 'image':
        return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="2" y="2" width="20" height="20" rx="3" stroke="currentColor" stroke-width="1.8"/><circle cx="8.5" cy="8.5" r="2" stroke="currentColor" stroke-width="1.8"/><path d="M22 16l-5.5-5.5-6 6L7 13l-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
      case 'video':
        return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="2" y="4" width="16" height="16" rx="3" stroke="currentColor" stroke-width="1.8"/><path d="M18 10l4.5-3v10L18 14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      case 'audio':
        return '<svg class="audio-wave" width="20" height="20" viewBox="0 0 24 24" fill="none"><rect class="wave-bar" x="3" y="10" width="3" height="6" rx="1.5" fill="currentColor"/><rect class="wave-bar" x="8" y="5" width="3" height="16" rx="1.5" fill="currentColor"/><rect class="wave-bar" x="13" y="8" width="3" height="9" rx="1.5" fill="currentColor"/><rect class="wave-bar" x="18" y="11" width="3" height="4" rx="1.5" fill="currentColor"/></svg>';
      case 'stream':
        return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" fill="currentColor"/><path d="M7 7a8 8 0 000 10M17 7a8 8 0 010 10M4 4a12 12 0 000 16M20 4a12 12 0 000 16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
      default:
        return '';
    }
  }

  /** 格式化文件大小为人类可读字符串 */
  function formatSize(bytes) {
    if (!bytes || bytes <= 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /** 截断 URL 用于显示 */
  function truncateUrl(url, max = 50) {
    if (url.length <= max) return url;
    return url.substring(0, max - 3) + '...';
  }

  function getCurrentTab() {
    return chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      return tabs[0];
    });
  }

  function sendMessage(msg) {
    return chrome.runtime.sendMessage(msg);
  }

  // ========== Toast 提示 ==========

  /** 显示短暂的 Toast 提示消息（2 秒后自动消失） */
  function showToast(msg) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
  }

  // ========== 加载/错误状态管理 ==========

  /** 设置加载状态 */
  function setLoading(loading) {
    els.statusText.textContent = loading ? '正在扫描页面资源...' : '';
    els.statusText.style.display = loading ? '' : 'none';
    els.retryBtn.style.display = 'none';
    if (loading) {
      els.resourceList.innerHTML = `<div class="list-empty"><div class="spinner"></div><p>正在扫描页面资源...</p></div>`;
    }
  }

  function setError(msg) {
    els.statusText.textContent = msg;
    els.statusText.style.display = '';
    els.retryBtn.style.display = '';
    els.resourceList.innerHTML = `<div class="list-empty">
      <p>${msg}</p>
    </div>`;
  }

  // ========== 加载资源 ==========

  /** 从后台获取当前标签页的资源列表 */
  function loadResources() {
    setLoading(true);
    sendMessage({ action: 'get_resources', tabId: currentTabId })
      .then(response => {
        if (!response || !response.resources) {
          setError('无法获取资源列表');
          return;
        }
        allResources = response.resources;
        applyFilter(currentFilter, currentFormat, currentSize);
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to load resources:', err);
        setError('连接后台失败，请刷新页面重试');
      });
  }

  // ========== 手动触发扫描 ==========

  /** 通知 Content Script 立即执行 DOM 扫描 */
  function triggerScan() {
    setLoading(true);
    chrome.tabs.sendMessage(currentTabId, { action: 'scanNow' }).catch(() => {
      // content script might not be injected yet
    });
    // Give content script time to report, then reload
    setTimeout(loadResources, 800);
    showToast('正在扫描...');
  }

  // ========== 渲染与筛选 ==========

  // 文件大小筛选阈值定义（字节）
  const SIZE_RANGES = {
    'lt1m':     [0,              1024 * 1024],
    '1m-10m':   [1024 * 1024,    10 * 1024 * 1024],
    '10m-100m': [10 * 1024 * 1024, 100 * 1024 * 1024],
    'gt100m':   [100 * 1024 * 1024, Infinity]
  };

  function applyFilter(type, format, size) {
    if (type !== undefined && type !== null) {
      // Switching type resets size filter (only video gets size filtering)
      if (type !== currentFilter && type !== 'video') currentSize = 'all';
      currentFilter = type;
    }
    if (format !== undefined && format !== null) currentFormat = format;
    if (size !== undefined && size !== null) currentSize = size;

    // Step 1: filter by type
    let list = currentFilter === 'all'
      ? [...allResources]
      : allResources.filter(r => r.type === currentFilter);

    // Step 2: filter by format
    if (currentFormat !== 'all') {
      list = list.filter(r => (r.format || '') === currentFormat);
    }

    // Step 3: filter by size (only meaningful for video type)
    if (currentSize !== 'all' && currentFilter === 'video') {
      const range = SIZE_RANGES[currentSize];
      if (range) {
        list = list.filter(r => r.size >= range[0] && r.size < range[1]);
      }
    }

    // Step 4: filter by search term (name + URL)
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      list = list.filter(r => {
        const name = (r.name || r.filename || '').toLowerCase();
        const url = r.url.toLowerCase();
        return name.includes(term) || url.includes(term);
      });
    }

    filteredResources = list;
    updateCounts();
    updateFormatFilters();
    updateSizeFilters();
    renderList();
    updateFilterButtons();
    updateFormatChipButtons();
    updateSizeChipButtons();
    updateSearchClear();
  }

  /** 搜索输入处理（带防抖） */
  function onSearchInput() {
    const val = els.searchInput.value;
    if (val === searchTerm) return;
    searchTerm = val;
    // Debounce search for smooth typing
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      applyFilter();
    }, 150);
  }

  /** 清除搜索 */
  function clearSearch() {
    els.searchInput.value = '';
    searchTerm = '';
    applyFilter();
    els.searchInput.focus();
  }

  /** 更新清除搜索按钮的显示状态 */
  function updateSearchClear() {
    els.searchClear.style.display = searchTerm ? '' : 'none';
  }

  /** 更新类型筛选按钮的高亮状态 */
  function updateFilterButtons() {
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.type === currentFilter);
    });
  }

  // Build format filter chips from available resources
  function updateFormatFilters() {
    const container = els.formatFilters;
    if (!container) return;

    // Collect format counts from resources matching current type filter
    const typeList = currentFilter === 'all'
      ? allResources
      : allResources.filter(r => r.type === currentFilter);
    const formatCounts = {};
    for (const r of typeList) {
      const fmt = r.format || guessFormat(r.url, r.type);
      formatCounts[fmt] = (formatCounts[fmt] || 0) + 1;
    }

    // Sort formats by count desc, then alphabetically
    const sorted = Object.entries(formatCounts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    // Build chip HTML
    let html = `<button class="format-chip${currentFormat === 'all' ? ' active' : ''}" data-format="all">全部 <span class="format-count">${typeList.length}</span></button>`;
    for (const [fmt, count] of sorted) {
      html += `<button class="format-chip${currentFormat === fmt ? ' active' : ''}" data-format="${fmt}">${fmt} <span class="format-count">${count}</span></button>`;
    }
    container.innerHTML = html;

    // Attach click listeners
    container.querySelectorAll('.format-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const fmt = chip.dataset.format;
        applyFilter(null, fmt === currentFormat && fmt !== 'all' ? 'all' : fmt);
      });
    });
  }

  function updateFormatChipButtons() {
    document.querySelectorAll('.format-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.format === currentFormat);
    });
  }

  // Show/hide and update size filter chips (visible only for video type)
  function updateSizeFilters() {
    const container = els.sizeFilters;
    if (!container) return;
    const isVideo = currentFilter === 'video';
    container.style.display = isVideo ? '' : 'none';
    if (isVideo) {
      // Count videos in each size range
      const videoList = allResources.filter(r => r.type === 'video');
      const counts = { lt1m: 0, '1m-10m': 0, '10m-100m': 0, gt100m: 0 };
      for (const r of videoList) {
        const s = r.size;
        if (s < 0) continue;
        if (s < 1024 * 1024) counts.lt1m++;
        else if (s < 10 * 1024 * 1024) counts['1m-10m']++;
        else if (s < 100 * 1024 * 1024) counts['10m-100m']++;
        else counts.gt100m++;
      }
      container.querySelectorAll('.size-chip').forEach(chip => {
        const key = chip.dataset.size;
        if (key !== 'all' && counts[key] !== undefined) {
          let span = chip.querySelector('.size-count');
          if (!span) { span = document.createElement('span'); span.className = 'size-count'; chip.appendChild(span); }
          span.textContent = counts[key];
        }
      });
    }
  }

  function updateSizeChipButtons() {
    document.querySelectorAll('.size-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.size === currentSize);
    });
  }

  // Guess format from URL + type (client-side fallback when background hasn't stored it)
  function guessFormat(url, type) {
    const m = url.match(/\.([a-z0-9]+)(?:[\?#]|$)/i);
    const ext = m ? m[1].toLowerCase() : '';
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
    if (type === 'stream' && /m3u8/i.test(url)) return 'M3U8';
    if (type === 'stream' && /mpd/i.test(url)) return 'MPD';
    if (ext && ext.length <= 5) return ext.toUpperCase();
    return type === 'image' ? 'IMG' : type === 'video' ? 'VID' : type === 'audio' ? 'AUD' : type === 'stream' ? 'STRM' : '?';
  }

  function updateCounts() {
    const counts = { all: allResources.length, image: 0, video: 0, stream: 0, audio: 0 };
    for (const r of allResources) {
      if (counts[r.type] !== undefined) counts[r.type]++;
    }
    els.totalCount.textContent = counts.all;
    els.countAll.textContent = counts.all;
    els.countImage.textContent = counts.image;
    els.countVideo.textContent = counts.video;
    els.countStream.textContent = counts.stream;
    els.countAudio.textContent = counts.audio;
  }

  /** 渲染资源列表 */
  function renderList() {
    const list = els.resourceList;
    list.innerHTML = '';

    if (filteredResources.length === 0) {
      let reason = '';
      if (allResources.length === 0) {
        reason = '未检测到资源<br><span class="text-muted">浏览页面后点击"重新扫描"</span>';
      } else {
        const parts = [];
        if (currentFilter !== 'all') parts.push(currentFilter);
        if (currentFormat !== 'all') parts.push(currentFormat);
        if (currentSize !== 'all') {
          const labels = { lt1m: '1M以下', '1m-10m': '1M~10M', '10m-100m': '10M~100M', gt100m: '100M以上' };
          parts.push(labels[currentSize] || currentSize);
        }
        reason = `没有${parts.join(' / ')}类型的资源`;
      }
      list.innerHTML = `<div class="list-empty"><p>${reason}</p></div>`;
      return;
    }

    // 按发现时间倒序排列，最多显示 200 项（性能限制）
    const sorted = [...filteredResources].sort((a, b) => b.detectedAt - a.detectedAt);
    const toShow = sorted.slice(0, 200);

    for (const res of toShow) {
      const item = renderResourceItem(res);
      list.appendChild(item);
    }

    if (sorted.length > 200) {
      const more = document.createElement('div');
      more.className = 'list-empty';
      more.style.height = 'auto';
      more.style.padding = '12px';
      more.innerHTML = `<p class="text-muted">仅显示前 200 项（共 ${sorted.length} 项）</p>`;
      list.appendChild(more);
    }

    // Re-check selected URLs
    selectedUrls.forEach(url => {
      const cb = list.querySelector(`.resource-checkbox[value="${CSS.escape(url)}"]`);
      if (cb) cb.checked = true;
    });

    updateDownloadButton();
  }

  function renderResourceItem(res) {
    const template = els.template.content.cloneNode(true);
    const item = template.querySelector('.resource-item');
    item.dataset.type = res.type;

    const checkbox = template.querySelector('.resource-checkbox');
    checkbox.value = res.url;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        selectedUrls.add(res.url);
      } else {
        selectedUrls.delete(res.url);
      }
      updateDownloadButton();
    });

    // Preview thumbnail — clickable to open full preview modal
    const preview = template.querySelector('.resource-preview');
    preview.style.cursor = 'pointer';
    preview.title = '点击预览';
    preview.addEventListener('click', (e) => {
      e.stopPropagation();
      openPreview(res);
    });
    if (res.type === 'image') {
      const img = document.createElement('img');
      img.src = res.url;
      img.loading = 'lazy';
      img.onerror = () => {
        preview.innerHTML = '';
        preview.classList.add('preview-fallback');
        preview.innerHTML = svgIcon('image');
      };
      preview.appendChild(img);
    } else if (res.type === 'video') {
      const video = document.createElement('video');
      video.src = res.url;
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      video.style.width = '100%';
      video.style.height = '100%';
      video.style.objectFit = 'cover';
      video.onerror = () => {
        preview.innerHTML = '';
        preview.classList.add('preview-fallback');
        preview.innerHTML = svgIcon('video');
      };
      // Seek to first frame for thumbnail
      video.addEventListener('loadedmetadata', () => {
        if (video.duration > 0 && isFinite(video.duration)) {
          video.currentTime = Math.min(video.duration, 1.0);
        }
      }, { once: true });
      video.addEventListener('seeked', () => {
        video.pause();
      }, { once: true });
      preview.appendChild(video);
    } else if (res.type === 'audio') {
      preview.classList.add('preview-audio');
      preview.innerHTML = svgIcon('audio');
    } else {
      preview.classList.add('preview-fallback');
      preview.innerHTML = svgIcon('stream');
    }

    // Name — prefer human-readable `name` (from alt/title/context) over URL-derived `filename`
    const isRandomName = (s) => s && (
      /^[a-f0-9]{16,}$/i.test(s) ||                                    // pure hex hash
      /^[a-zA-Z0-9+/=_\-]{20,}$/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s) || // base64-like
      /^[a-zA-Z0-9]{24,}$/.test(s)                                      // long random alpha
    );
    const hasGoodName = res.name && res.name.length > 2 && !isRandomName(res.name)
      && res.name !== res.filename;
    const displayName = hasGoodName ? res.name : (res.filename || 'unknown');
    const nameEl = template.querySelector('.resource-name');
    nameEl.textContent = displayName;
    // 重命名按钮（允许用户手动修改文件名）
    const renameBtn = template.querySelector('.btn-rename');
    if (renameBtn) {
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startRename(res, nameEl);
      });
    }
    // Show URL-derived filename as subtitle if it differs from the display name
    if (hasGoodName && res.filename && res.filename !== res.name) {
      const subEl = document.createElement('span');
      subEl.className = 'resource-name-sub';
      subEl.textContent = res.filename;
      nameEl.parentNode.appendChild(subEl);
    }
    // Pair group indicator
    if (res.groupId) {
      item.dataset.groupId = res.groupId;
      item.classList.add('has-group');
      const groupBadge = document.createElement('span');
      groupBadge.className = 'group-badge';
      groupBadge.textContent = 'P' + (res.type === 'video' ? 'V' : 'A');
      nameEl.parentNode.appendChild(groupBadge);
    }

    // Meta
    const badge = template.querySelector('.resource-type-badge');
    badge.textContent = typeBadgeLabel(res.type);
    // Format badge (second badge after type)
    const fmtBadge = template.querySelector('.resource-format-badge');
    if (fmtBadge) {
      const fmt = res.format || guessFormat(res.url, res.type);
      fmtBadge.textContent = fmt;
    }
    // Type switcher (dropdown to manually override type)
    const typeSwitcher = template.querySelector('.resource-type-switcher');
    if (typeSwitcher) {
      typeSwitcher.value = res.type;
      typeSwitcher.addEventListener('change', () => {
        const oldType = res.type;
        const newType = typeSwitcher.value;
        if (newType === oldType) return;

        // Update local resource entry
        res.type = newType;
        res.format = guessFormat(res.url, newType);

        // Update UI badges
        badge.textContent = typeBadgeLabel(newType);
        if (fmtBadge) fmtBadge.textContent = res.format;

        // Update preview thumbnail icon
        const preview = item.querySelector('.resource-preview');
        if (preview && (oldType !== 'image' && oldType !== 'video')) {
          // Only update if it was a fallback icon (not real media)
          if (!preview.querySelector('img, video')) {
            preview.innerHTML = '';
            preview.className = 'resource-preview';
            if (newType === 'audio') {
              preview.classList.add('preview-audio');
              preview.innerHTML = svgIcon('audio');
            } else if (newType === 'stream') {
              preview.classList.add('preview-fallback');
              preview.innerHTML = svgIcon('stream');
            }
          }
        }

        // Remove pairing group badge hint if type changed
        const groupBadge = item.querySelector('.group-badge');
        if (groupBadge) {
          groupBadge.textContent = 'P' + (newType === 'video' ? 'V' : 'A');
        }

        // Sync to background
        sendMessage({
          action: 'change_resource_type',
          url: res.url,
          newType
        });

        // Re-run filter to possibly include/exclude this item
        applyFilter();
      });
    }
    const sizeEl = template.querySelector('.resource-size');
    sizeEl.textContent = formatSize(res.size);

    // URL
    const urlEl = template.querySelector('.resource-url');
    urlEl.textContent = res.url;
    urlEl.title = res.url;

    // 操作按钮区
    const _actEl = template.querySelector('.resource-actions');

    // 下载按钮
    _actEl.querySelector('button:first-child').addEventListener('click', () => {
      sendMessage({
        action: 'download_resource',
        url: res.url,
        filename: res.filename
      });
      showToast('下载已开始');
    });

    // 复制 URL 按钮
    _actEl.querySelector('button:nth-child(2)').addEventListener('click', () => {
      navigator.clipboard.writeText(res.url).then(() => {
        showToast('链接已复制');
      }).catch(() => {
        // 降级方案：使用 textarea 复制
        const ta = document.createElement('textarea');
        ta.value = res.url;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('链接已复制');
      });
    });

    // 在新标签页中打开
    _actEl.querySelector('button:last-child').addEventListener('click', () => {
      window.open(res.url, '_blank');
    });

    return item;
  }

  function updateDownloadButton() {
    try {
      const count = selectedUrls.size;
      const btn = els.downloadSelectedBtn;
      const mergeBtn = els.mergeDownloadBtn;
      btn.disabled = count === 0;
      btn.innerHTML = count > 0
        ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M7 10l5 5 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 15V3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> 下载选中 (${count})`
        : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M7 10l5 5 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 15V3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> 下载选中`;

      // Check if selected items form any video+audio pairs
      if (mergeBtn) {
        const pairs = getPairedResources(selectedUrls);
        if (pairs.length > 0) {
          mergeBtn.style.display = '';
          mergeBtn.disabled = false;
          mergeBtn.textContent = `音视频合成下载 (${pairs.length})`;
        } else {
          mergeBtn.style.display = 'none';
          mergeBtn.disabled = true;
        }
      }
    } catch (e) {
      console.warn('updateDownloadButton error:', e);
    }
  }

  // ========== 重命名功能 ==========

  /** 进入重命名模式：将名称文本替换为输入框 */
  function startRename(res, nameEl) {
    const currentName = nameEl.textContent;
    const input = document.createElement('input');
    input.className = 'rename-input';
    input.type = 'text';
    input.value = currentName;
    input.autofocus = true;
    nameEl.textContent = '';
    nameEl.appendChild(input);
    input.focus();
    input.select();

    const finish = () => finishRename(res, nameEl, input);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(); }
      if (e.key === 'Escape') { e.preventDefault(); nameEl.textContent = currentName; }
    });
    input.addEventListener('blur', finish);
  }

  /** 完成重命名：保存新名称并同步到后台 */
  function finishRename(res, nameEl, input) {
    const newName = input.value.trim();
    if (!newName) {
      nameEl.textContent = res.name || res.filename || 'unknown';
      return;
    }
    nameEl.textContent = newName;
    // Update local entry
    if (allResources.length > 0) {
      for (const r of allResources) {
        if (r.url === res.url) {
          r.name = newName;
          break;
        }
      }
    }
    // Sync to background
    sendMessage({ action: 'rename_resource', url: res.url, newName });
  }

  // ========== 音视频配对与合成 ==========

  /**
   * 从选中的资源中找出可配对的视频+音频组
   * 配对逻辑：
   * 1. 优先使用 groupId 配对的资源
   * 2. 剩余未配对的资源中，手动将 video 和 audio 类型配对
   */
  function getPairedResources(selected) {
    // Among selected URLs, find groups that contain both video and audio
    const groupMap = {};
    if (!allResources.length) return [];

    // Step 1: collect groupId-based matches
    for (const r of allResources) {
      if (selected.has(r.url) && r.groupId) {
        if (!groupMap[r.groupId]) groupMap[r.groupId] = [];
        groupMap[r.groupId].push(r);
      }
    }

    const pairs = [];
    for (const gid of Object.keys(groupMap)) {
      const members = groupMap[gid];
      const videos = members.filter(m => m.type === 'video');
      const audios = members.filter(m => m.type === 'audio');
      if (videos.length > 0 && audios.length > 0) {
        pairs.push({ videoUrl: videos[0].url, audioUrl: audios[0].url, baseName: videos[0].name || videos[0].filename || 'merged' });
      }
    }

    // Step 2: look for orphan video+audio pairs (user manually corrected types)
    // Only match pairs that are NOT already matched via groupId
    const matchedUrls = new Set();
    for (const p of pairs) {
      matchedUrls.add(p.videoUrl);
      matchedUrls.add(p.audioUrl);
    }
    const unmatchedSelected = Array.from(selected).filter(url => !matchedUrls.has(url));
    const unmatchedResources = allResources.filter(r => unmatchedSelected.includes(r.url));
    const orphanVideos = unmatchedResources.filter(r => r.type === 'video');
    const orphanAudios = unmatchedResources.filter(r => r.type === 'audio');
    const orphanCount = Math.min(orphanVideos.length, orphanAudios.length);
    for (let i = 0; i < orphanCount; i++) {
      const v = orphanVideos[i];
      const a = orphanAudios[i];
      pairs.push({
        videoUrl: v.url,
        audioUrl: a.url,
        baseName: v.name || v.filename || 'merged'
      });
    }

    return pairs;
  }

  /** 启动音视频合成下载 */
  function mergeDownload() {
    const pairs = getPairedResources(selectedUrls);
    if (pairs.length === 0) {
      showToast('\u6CA1\u6709\u53EF\u5408\u6210\u7684\u97F3\u89C6\u9891\u5BF9');
      return;
    }
    for (const pair of pairs) {
      sendMessage({
        action: 'merge_download',
        videoUrl: pair.videoUrl,
        audioUrl: pair.audioUrl,
        baseName: pair.baseName
      });
    }
    showToast(`\u5DF2\u542F\u52A8 ${pairs.length} \u4E2A\u97F3\u89C6\u9891\u5408\u6210\u4E0B\u8F7D`);
  }

  // ========== 预览弹窗 ==========

  let previewRes = null;

  /** 打开展预览弹窗 */
  function openPreview(res) {
    previewRes = res;
    const overlay = els.previewOverlay;
    const body = els.previewBody;
    body.innerHTML = '';

    // Set header
    els.previewName.textContent = res.name || res.filename || '未知资源';
    els.previewUrl.textContent = res.url;
    // Download link
    els.previewDownload.href = res.url;
    els.previewDownload.download = res.filename || '';

    // Render preview content by type
    if (res.type === 'image') {
      const img = document.createElement('img');
      img.className = 'preview-media-image';
      img.src = res.url;
      img.alt = res.name || 'preview';
      img.onerror = () => {
        img.style.display = 'none';
        body.innerHTML = '<div class="preview-error">图片加载失败</div>';
      };
      body.appendChild(img);
    } else if (res.type === 'video') {
      const video = document.createElement('video');
      video.className = 'preview-media-video';
      video.src = res.url;
      video.controls = true;
      video.autoplay = false;
      video.preload = 'auto';
      video.onerror = () => {
        video.style.display = 'none';
        body.innerHTML = '<div class="preview-error">视频加载失败</div>';
      };
      body.appendChild(video);
    } else if (res.type === 'audio') {
      const wrapper = document.createElement('div');
      wrapper.className = 'preview-audio-wrapper';
      // Large waveform icon
      const waveSvg = document.createElement('div');
      waveSvg.className = 'preview-audio-wave';
      waveSvg.innerHTML = svgIcon('audio');
      // Audio element
      const audio = document.createElement('audio');
      audio.className = 'preview-media-audio';
      audio.src = res.url;
      audio.controls = true;
      audio.autoplay = false;
      audio.preload = 'auto';
      audio.onerror = () => {
        wrapper.innerHTML = '<div class="preview-error">音频加载失败</div>';
      };
      wrapper.appendChild(waveSvg);
      wrapper.appendChild(audio);
      body.appendChild(wrapper);
    } else if (res.type === 'stream') {
      body.innerHTML = '<div class="preview-error">直播流不支持直接预览<br><span class="text-muted">请使用下载或在新标签页中打开</span></div>';
    } else {
      body.innerHTML = '<div class="preview-error">该资源类型不支持预览</div>';
    }

    overlay.style.display = '';
    document.body.style.overflow = 'hidden';
  }

  /** 关闭预览弹窗 */
  function closePreview() {
    const overlay = els.previewOverlay;
    overlay.style.display = 'none';
    els.previewBody.innerHTML = '';
    document.body.style.overflow = '';
    previewRes = null;
  }

  // ========== 批量下载 ==========

  /** 下载所有选中的资源（含自动音视频合成配对） */
  function downloadSelected() {
    const urls = Array.from(selectedUrls);
    if (urls.length === 0) return;

    // Check if selected items form video+audio pairs (auto-merge)
    const pairs = getPairedResources(selectedUrls);
    if (pairs.length > 0) {
      // Count how many URLs are consumed by pairs
      const pairedUrls = new Set();
      for (const p of pairs) {
        pairedUrls.add(p.videoUrl);
        pairedUrls.add(p.audioUrl);
      }
      // If ALL selected URLs are part of pairs, fully merge
      // Otherwise merge the pairs and download the rest individually
      const unpaired = urls.filter(url => !pairedUrls.has(url));

      // Trigger merges
      for (const pair of pairs) {
        sendMessage({
          action: 'merge_download',
          videoUrl: pair.videoUrl,
          audioUrl: pair.audioUrl,
          baseName: pair.baseName
        });
      }

      // Download unpaired items individually
      if (unpaired.length > 0) {
        const urlMap = new Map(allResources.map(r => [r.url, r]));
        for (const url of unpaired) {
          const res = urlMap.get(url);
          sendMessage({
            action: 'download_resource',
            url,
            filename: res ? res.filename : undefined
          });
        }
      }

      const totalJobs = pairs.length + unpaired.length;
      const parts = [];
      if (pairs.length) parts.push(pairs.length + ' 个合成');
      if (unpaired.length) parts.push(unpaired.length + ' 个单独下载');
      showToast('正在处理: ' + parts.join(', '));
      return;
    }

    // No pairs: download each individually
    const toDownload = [];
    const urlMap = new Map(allResources.map(r => [r.url, r]));
    for (const url of urls) {
      const res = urlMap.get(url);
      toDownload.push({ url, filename: res ? res.filename : undefined });
    }

    for (const item of toDownload) {
      sendMessage({
        action: 'download_resource',
        url: item.url,
        filename: item.filename
      });
    }

    const label = toDownload.length > 0 ? toDownload.length + ' 个文件' : '';
    showToast('正在下载 ' + label);
  }

  // ========== 清空资源 ==========

  /** 清空当前标签页的资源列表 */
  function clearResources() {
    if (allResources.length === 0) return;
    sendMessage({ action: 'clear_resources', tabId: currentTabId });
    allResources = [];
    filteredResources = [];
    selectedUrls.clear();
    currentFormat = 'all';
    currentSize = 'all';
    applyFilter('all');
    showToast('已清空');
  }

  // ========== 嗅探开关 ==========

  /** 更新嗅探开关的 UI 状态 */
  function updateSniffingUI() {
    els.sniffToggle.classList.toggle('disabled', tabSniffingDisabled);
    els.sniffBanner.style.display = tabSniffingDisabled ? '' : 'none';
    els.sniffToggle.title = tabSniffingDisabled ? '\u6062\u590D\u55C5\u63A2' : '\u6682\u505C\u55C5\u63A2';
    els.scanBtn.disabled = tabSniffingDisabled;
    els.scanBtn.style.opacity = tabSniffingDisabled ? '0.4' : '';
    els.scanBtn.style.cursor = tabSniffingDisabled ? 'not-allowed' : '';
  }

  /** 切换当前标签页的嗅探开关 */
  function toggleTabSniffing() {
    sendMessage({ action: 'toggle_tab_sniffing', tabId: currentTabId }).then(response => {
      if (response) {
        tabSniffingDisabled = response.disabled;
        updateSniffingUI();
        showToast(tabSniffingDisabled ? '\u55C5\u63A2\u5DF2\u6682\u505C' : '\u55C5\u63A2\u5DF2\u6062\u590D');
        if (tabSniffingDisabled) {
          setLoading(false);
        } else {
          triggerScan();
        }
      }
    }).catch(() => showToast('\u64CD\u4F5C\u5931\u8D25'));
  }

  // ---- Init ----

  function init() {
    getCurrentTab().then(tab => {
      if (!tab) {
        setError('无法获取当前标签页');
        return;
      }
      currentTabId = tab.id;

      // Query sniffing state for this tab
      sendMessage({ action: 'get_tab_sniffing_state', tabId: currentTabId }).then(response => {
        if (response) {
          tabSniffingDisabled = response.disabled;
          updateSniffingUI();
        }
      }).catch(() => {});

      // Load initial resources
      loadResources();

      // Content script is auto-injected via manifest.json.
      // Send a ping to verify it's loaded; if not, the scan button will still work.
      chrome.tabs.sendMessage(currentTabId, { action: 'ping' }).catch(() => {});
    }).catch(err => {
      console.error('Init error:', err);
      setError('初始化失败: ' + err.message);
    });

    // Event listeners: type filter
    els.filters.addEventListener('click', (e) => {
      const btn = e.target.closest('.filter-btn');
      if (btn) {
        const newType = btn.dataset.type;
        applyFilter(newType); // applyFilter resets size when switching away from video
      }
    });

    // Size filter chips
    els.sizeFilters.addEventListener('click', (e) => {
      const chip = e.target.closest('.size-chip');
      if (chip) {
        const sz = chip.dataset.size;
        applyFilter(null, null, sz === currentSize && sz !== 'all' ? 'all' : sz);
      }
    });

    els.scanBtn.addEventListener('click', triggerScan);

    els.downloadSelectedBtn.addEventListener('click', downloadSelected);

    els.mergeDownloadBtn.addEventListener('click', mergeDownload);

    els.clearBtn.addEventListener('click', clearResources);

    els.retryBtn.addEventListener('click', loadResources);

    els.sniffToggle.addEventListener('click', toggleTabSniffing);

    // Preview modal
    els.previewClose.addEventListener('click', closePreview);
    els.previewOverlay.addEventListener('click', (e) => {
      if (e.target === els.previewOverlay) closePreview();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePreview();
    });

    // Search
    els.searchInput.addEventListener('input', onSearchInput);
    els.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') clearSearch();
    });
    els.searchClear.addEventListener('click', clearSearch);
  }

  // Wait for DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

// Res-Find Popup Script
// Displays detected resources, handles filtering, download, copy

(function () {
  'use strict';

  let currentTabId = null;
  let allResources = [];
  let filteredResources = [];
  let selectedUrls = new Set();
  let currentFilter = 'all';

  const els = {
    totalCount: document.getElementById('totalCount'),
    countAll: document.getElementById('countAll'),
    countImage: document.getElementById('countImage'),
    countVideo: document.getElementById('countVideo'),
    countStream: document.getElementById('countStream'),
    countAudio: document.getElementById('countAudio'),
    filters: document.getElementById('filters'),
    resourceList: document.getElementById('resourceList'),
    scanBtn: document.getElementById('scanNowBtn'),
    downloadSelectedBtn: document.getElementById('downloadSelectedBtn'),
    clearBtn: document.getElementById('clearBtn'),
    statusText: document.getElementById('statusText'),
    retryBtn: document.getElementById('retryBtn'),
    emptyMessage: document.getElementById('emptyMessage'),
    template: document.getElementById('resourceItem'),
  };

  // ---- Utils ----

  function typeBadgeLabel(type) {
    switch (type) {
      case 'image': return 'IMG';
      case 'video': return 'VID';
      case 'stream': return 'STRM';
      case 'audio': return 'AUD';
      default: return type.toUpperCase();
    }
  }

  function getPreviewIcon(type) {
    return '';
  }

  function formatSize(bytes) {
    if (!bytes || bytes <= 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

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

  // ---- Toast ----

  function showToast(msg) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
  }

  // ---- Loading state ----

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

  // ---- Load resources ----

  function loadResources() {
    setLoading(true);
    sendMessage({ action: 'get_resources', tabId: currentTabId })
      .then(response => {
        if (!response || !response.resources) {
          setError('无法获取资源列表');
          return;
        }
        allResources = response.resources;
        applyFilter(currentFilter);
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to load resources:', err);
        setError('连接后台失败，请刷新页面重试');
      });
  }

  // ---- Trigger content script scan ----

  function triggerScan() {
    setLoading(true);
    chrome.tabs.sendMessage(currentTabId, { action: 'scanNow' }).catch(() => {
      // content script might not be injected yet
    });
    // Give content script time to report, then reload
    setTimeout(loadResources, 800);
    showToast('正在扫描...');
  }

  // ---- Render ----

  function applyFilter(type) {
    currentFilter = type;
    if (type === 'all') {
      filteredResources = [...allResources];
    } else {
      filteredResources = allResources.filter(r => r.type === type);
    }
    updateCounts();
    renderList();
    updateFilterButtons();
  }

  function updateFilterButtons() {
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.type === currentFilter);
    });
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

  function renderList() {
    const list = els.resourceList;
    list.innerHTML = '';

    if (filteredResources.length === 0) {
      const filterLabel = currentFilter === 'all' ? '' : ` ${currentFilter}`;
      const msg = allResources.length === 0
        ? '未检测到资源<br><span class="text-muted">浏览页面后点击"重新扫描"</span>'
        : `没有${filterLabel}类型的资源`;
      list.innerHTML = `<div class="list-empty"><p>${msg}</p></div>`;
      return;
    }

    // Show only the most recent resources, sorted by detectedAt descending
    const sorted = [...filteredResources].sort((a, b) => b.detectedAt - a.detectedAt);
    const toShow = sorted.slice(0, 200); // limit display

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

    // Preview
    const preview = template.querySelector('.resource-preview');
    if (res.type === 'image') {
      const img = document.createElement('img');
      img.src = res.url;
      img.loading = 'lazy';
      img.onerror = () => {
        preview.textContent = '\uD83D\uDDBC';
      };
      preview.appendChild(img);
    } else {
      const icons = {
        video: '\uD83C\uDFA5',
        stream: '\uD83D\uDD34',
        audio: '\uD83C\uDFB5'
      };
      preview.textContent = icons[res.type] || '\uD83D\uDCC4';
    }

    // Name
    const nameEl = template.querySelector('.resource-name');
    nameEl.textContent = res.filename || 'unknown';

    // Meta
    const badge = template.querySelector('.resource-type-badge');
    badge.textContent = typeBadgeLabel(res.type);
    const sizeEl = template.querySelector('.resource-size');
    sizeEl.textContent = formatSize(res.size);

    // URL
    const urlEl = template.querySelector('.resource-url');
    urlEl.textContent = res.url;
    urlEl.title = res.url;

    // Action buttons
    const actions = template.querySelectorAll('.resource-actions .btn-icon');

    // Download
    actions[0].addEventListener('click', () => {
      sendMessage({
        action: 'download_resource',
        url: res.url,
        filename: res.filename
      });
      showToast('下载已开始');
    });

    // Copy URL
    actions[1].addEventListener('click', () => {
      navigator.clipboard.writeText(res.url).then(() => {
        showToast('链接已复制');
      }).catch(() => {
        // fallback
        const ta = document.createElement('textarea');
        ta.value = res.url;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('链接已复制');
      });
    });

    // Open in new tab
    actions[2].addEventListener('click', () => {
      window.open(res.url, '_blank');
    });

    return item;
  }

  function updateDownloadButton() {
    const count = selectedUrls.size;
    const btn = els.downloadSelectedBtn;
    btn.disabled = count === 0;
    btn.innerHTML = count > 0
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M7 10l5 5 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 15V3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> 下载选中 (${count})`
      : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M7 10l5 5 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 15V3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> 下载选中`;
  }

  // ---- Download all visible ----

  function downloadSelected() {
    const urls = Array.from(selectedUrls);
    if (urls.length === 0) return;

    // Find the resource details for each URL
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
    showToast(`正在下载 ${toDownload.length} 个文件`);
  }

  // ---- Clear ----

  function clearResources() {
    if (allResources.length === 0) return;
    sendMessage({ action: 'clear_resources', tabId: currentTabId });
    allResources = [];
    filteredResources = [];
    selectedUrls.clear();
    applyFilter('all');
    showToast('已清空');
  }

  // ---- Init ----

  function init() {
    getCurrentTab().then(tab => {
      if (!tab) {
        setError('无法获取当前标签页');
        return;
      }
      currentTabId = tab.id;

      // Load initial resources
      loadResources();

      // Content script is auto-injected via manifest.json.
      // Send a ping to verify it's loaded; if not, the scan button will still work.
      chrome.tabs.sendMessage(currentTabId, { action: 'ping' }).catch(() => {});
    }).catch(err => {
      console.error('Init error:', err);
      setError('初始化失败: ' + err.message);
    });

    // Event listeners
    els.filters.addEventListener('click', (e) => {
      const btn = e.target.closest('.filter-btn');
      if (btn) applyFilter(btn.dataset.type);
    });

    els.scanBtn.addEventListener('click', triggerScan);

    els.downloadSelectedBtn.addEventListener('click', downloadSelected);

    els.clearBtn.addEventListener('click', clearResources);

    els.retryBtn.addEventListener('click', loadResources);
  }

  // Wait for DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

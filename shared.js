/**
 * Res-Find 共享工具函数
 * ======================
 * background.js（Service Worker）通过 importScripts('shared.js') 加载，
 * popup.html 通过 <script src="shared.js"> 加载。
 * 所有函数挂载到全局作用域和 resFindShared 命名空间，以兼容两种环境。
 *
 * 注意：content.js 由于运行在 ISOLATED World 中无法直接 import，
 * 因此保留自身的工具函数副本，两者保持同步。
 */

(function () {
  'use strict';

  if (typeof resFindShared !== 'undefined') return;

  /* ========== 文件扩展名 ========== */

  /** 从 URL 中提取文件扩展名 */
  function tryGetExtension(url) {
    var m = url.match(/\.([a-z0-9]+)(?:[\?#]|$)/i);
    return m ? m[1].toLowerCase() : '';
  }

  /* ========== 格式映射 ========== */

  var FMT_MAP = {
    png: 'PNG', jpg: 'JPEG', jpeg: 'JPEG', gif: 'GIF', webp: 'WEBP',
    avif: 'AVIF', bmp: 'BMP', svg: 'SVG', ico: 'ICO', tif: 'TIFF', tiff: 'TIFF',
    mp4: 'MP4', webm: 'WEBM', ogv: 'OGV', mov: 'MOV', avi: 'AVI',
    mkv: 'MKV', flv: 'FLV', wmv: 'WMV', m4v: 'M4V', '3gp': '3GP',
    mp3: 'MP3', wav: 'WAV', flac: 'FLAC', aac: 'AAC', m4a: 'M4A',
    ogg: 'OGG', opus: 'OPUS', wma: 'WMA', aiff: 'AIFF',
    m3u8: 'M3U8', mpd: 'MPD'
  };

  /**
   * 根据 URL 后缀和资源类型推断显示格式标签
   * @param {string} url - 资源 URL
   * @param {string} type - 资源类型
   * @returns {string} 格式标签（如 "PNG", "MP4", "M3U8"）
   */
  function guessFormat(url, type) {
    var ext = tryGetExtension(url) || '';
    if (FMT_MAP[ext]) return FMT_MAP[ext];
    if (type === 'stream' && /m3u8/i.test(url)) return 'M3U8';
    if (type === 'stream' && /mpd/i.test(url)) return 'MPD';
    if (ext && ext.length <= 5) return ext.toUpperCase();
    return type === 'image' ? 'IMG' : type === 'video' ? 'VID' : type === 'audio' ? 'AUD' : type === 'stream' ? 'STRM' : '?';
  }

  /* ========== 随机哈希检测 ========== */

  /**
   * 检测文件名是否为自动生成的随机哈希值
   * @param {string} str - 待检测的字符串
   * @returns {boolean} true 表示看起来是随机哈希
   */
  function looksLikeRandomHash(str) {
    if (!str || str.length < 8) return false;
    var s = String(str);
    if (/^[a-f0-9]{16,}$/i.test(s)) return true;
    if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s)) return true;
    if (/^[a-zA-Z0-9+/=_\-]{20,}$/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s)) return true;
    if (/^[a-zA-Z0-9]{24,}$/.test(s)) return true;
    if (/^data:/i.test(s) || /^blob:/i.test(s)) return true;
    return false;
  }

  /* ========== 文件大小格式化 ========== */

  /**
   * 格式化文件大小为人类可读字符串
   * @param {number} bytes - 字节数（-1 表示未知）
   * @returns {string} 如 "1.5 MB", "340 KB", 未知则返回空字符串
   */
  function formatSize(bytes) {
    if (!bytes || bytes === -1) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /* ========== URL 清理 ========== */

  /** 移除 URL 中的查询参数，仅保留源和路径用于显示 */
  function cleanUrl(url) {
    try {
      var u = new URL(url);
      return u.origin + u.pathname;
    } catch (e) { return url; }
  }

  /* ========== 导出 ========== */

  var shared = {
    tryGetExtension: tryGetExtension,
    guessFormat: guessFormat,
    looksLikeRandomHash: looksLikeRandomHash,
    formatSize: formatSize,
    cleanUrl: cleanUrl
  };

  // 兼容 Service Worker（self）和浏览器 Window 两种环境
  var globalObj = typeof self !== 'undefined' ? self : window;
  for (var key in shared) {
    if (shared.hasOwnProperty(key)) {
      globalObj[key] = shared[key];
    }
  }
  globalObj.resFindShared = shared;
})();

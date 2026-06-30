/**
 * Res-Find 页面 Hook 脚本
 * ======================
 * 通过 <script> 标签注入到页面的 MAIN World 中执行。
 * 
 * 为什么需要这个脚本？
 * Chrome 扩展的 Content Script 运行在 ISOLATED World 中，
 * 无法拦截页面 JS 对原生 API 的调用。此脚本在 MAIN World 中
 * 通过 Monkey-patch 原生 API，捕获媒体 URL。
 *
 * 与 Content Script 通过 window.postMessage 通信。
 */

(function () {
  'use strict';

  /**
   * 通过 postMessage 向 Content Script 发送消息
   * @param {string} type - 消息类型
   * @param {Object} payload - 消息负载
   */
  function postMsg(type, payload) {
    window.postMessage(
      Object.assign({ source: '__resFind_hook', type: type }, payload),
      '*'
    );
  }

  // 匹配常见音视频和流媒体文件的正则
  var MEDIA_RE = /\.(m3u8|mpd|mp3|flac|aac|ogg|wma|m4a|opus|aiff|wav|mp4|webm)\b/i;

  /* ── 1. 拦截 HTMLMediaElement.prototype.src 赋值 ──
     无论通过何种框架设置 <video>/<audio> 的 src，都能捕获。
     在所有 hook 中优先级最高，覆盖面最广。 */
  try {
    var nativeSrcDesc = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      'src'
    );
    if (nativeSrcDesc && nativeSrcDesc.set) {
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        get: function () {
          return nativeSrcDesc.get.call(this);
        },
        set: function (url) {
          var prev = nativeSrcDesc.get.call(this);
          nativeSrcDesc.set.call(this, url);
          if (
            url &&
            typeof url === 'string' &&
            url !== prev &&
            !url.startsWith('blob:')
          ) {
            postMsg('mediaSrc', { url: url.split('#')[0], tag: this.tagName });
          }
        },
        configurable: true
      });
    }
  } catch (e) {
    /* prototype hook 不支持 */
  }

  /* ── 2. 拦截 Audio() 构造函数 ──
     捕获通过 new Audio(url) 创建的音频实例，
     许多纯音频播放器使用此模式。 */
  try {
    var OrigAudio = window.Audio;
    window.Audio = function (src) {
      var inst = new OrigAudio(src);
      if (src && typeof src === 'string' && !src.startsWith('blob:')) {
        postMsg('audioCtor', { url: src.split('#')[0] });
      }
      return inst;
    };
    window.Audio.prototype = OrigAudio.prototype;
  } catch (e) {
    /* Audio 构造函数拦截失败 */
  }

  /* ── 3. 拦截 fetch() 响应体 ──
     解析 JSON API 响应，扫描其中嵌入的媒体 CDN URL。
     很多站点的真实音视频 URL 隐藏在 API JSON 响应中。
     e.g. 抖音/B站的数据接口返回的 play_addr 等。 */
  try {
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      return origFetch.call(this, input, init).then(function (response) {
        var ct = (response.headers.get('content-type') || '').toLowerCase();
        if (ct.indexOf('json') !== -1) {
          response
            .clone()
            .json()
            .then(function (data) {
              scanForUrls(data);
            })
            .catch(function () {});
        }
        return response;
      });
    };
  } catch (e) {
    /* fetch 拦截失败 */
  }

  /* ── 4. 拦截 XMLHttpRequest 响应体 ──
     与 fetch 拦截相同，但针对仍在使用 XHR 的旧版站点。 */
  try {
    var XHR = window.XMLHttpRequest;
    var origOpen = XHR.prototype.open;
    var origSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      this.__resFindUrl = typeof url === 'string' ? url : String(url);
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.send = function (body) {
      if (this.__resFindUrl) {
        this.addEventListener('load', function () {
          try {
            var ct = (
              this.getResponseHeader('Content-Type') || ''
            ).toLowerCase();
            if (ct.indexOf('json') !== -1 && this.responseText) {
              scanForUrls(JSON.parse(this.responseText));
            }
          } catch (e) {
            /* JSON 解析错误 */
          }
        });
      }
      return origSend.apply(this, arguments);
    };
  } catch (e) {
    /* XHR 拦截失败 */
  }

  /* ── 5. 拦截 URL.createObjectURL （MSE/MediaSource 检测） ──
     检测 MediaSource 是否通过 blob URL 附加到媒体元素上。
     适用于使用 MSE（Media Source Extensions）的站点。 */
  try {
    var origCreate = URL.createObjectURL;
    URL.createObjectURL = function (obj) {
      var url = origCreate.call(this, obj);
      if (obj instanceof MediaSource) {
        postMsg('mseCreated', { blobUrl: url });
      }
      return url;
    };
  } catch (e) {
    /* createObjectURL 拦截失败 */
  }

  /* ── 递归 JSON 扫描器 ──
     深度遍历解析后的 API 响应对象，查找所有匹配媒体扩展名的 URL。
     最多递归 6 层以防止栈溢出。 */
  function scanForUrls(data, depth) {
    if (depth === undefined) depth = 0;
    if (depth > 6 || !data || typeof data !== 'object') return;

    if (Array.isArray(data)) {
      for (var i = 0; i < data.length; i++) scanForUrls(data[i], depth + 1);
      return;
    }

    for (var key in data) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
      var val = data[key];
      if (
        typeof val === 'string' &&
        val.length > 10 &&
        val.indexOf('http') === 0 &&
        MEDIA_RE.test(val)
      ) {
        postMsg('apiExtract', { url: val.split('#')[0], contextKey: key });
      } else if (val && typeof val === 'object') {
        scanForUrls(val, depth + 1);
      }
    }
  }
})();

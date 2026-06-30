// Res-Find Page Hook — runs in page MAIN world via injected <script>
// Intercepts JS-level APIs to capture media URLs before/during resource loading.
// Communicates with content script via window.postMessage.
(function () {
  'use strict';

  /* ── helpers ── */
  function postMsg(type, payload) {
    window.postMessage(
      Object.assign({ source: '__resFind_hook', type: type }, payload),
      '*'
    );
  }

  var MEDIA_RE = /\.(m3u8|mpd|mp3|flac|aac|ogg|wma|m4a|opus|aiff|wav|mp4|webm)\b/i;

  /* ── 1. HTMLMediaElement.prototype.src setter ──
     Catches every assignment to element.src, no matter which framework sets it. */
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
    /* prototype hook not supported */
  }

  /* ── 2. Audio() constructor ──
     Catches new Audio(url) pattern used by many audio-only players. */
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
    /* Audio hook failed */
  }

  /* ── 3. fetch() response body interception ──
     Reads JSON API responses and scans for embedded media CDN URLs
     (the real audio URL is often hidden inside an API JSON response). */
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
    /* fetch hook failed */
  }

  /* ── 4. XMLHttpRequest response body interception ──
     Same as fetch hook but for legacy XHR-based API calls. */
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
            /* parse error */
          }
        });
      }
      return origSend.apply(this, arguments);
    };
  } catch (e) {
    /* XHR hook failed */
  }

  /* ── 5. URL.createObjectURL (MSE/media source detection) ──
     Detects when a MediaSource is attached to a media element via blob URL. */
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
    /* createObjectURL hook failed */
  }

  /* ── recursive JSON scanner ──
     Walks a parsed API response looking for media CDN URLs. */
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

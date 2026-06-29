(function() {
  'use strict';

  const videoUrl = new URLSearchParams(location.search).get('video');
  const audioUrl = new URLSearchParams(location.search).get('audio');
  const baseName = new URLSearchParams(location.search).get('name') || 'merged';

  if (!videoUrl || !audioUrl) {
    document.getElementById('status').textContent = '\u7F3A\u5C11\u89C6\u9891\u6216\u97F3\u9891\u53C2\u6570';
    document.getElementById('status').className = 'status error';
    return;
  }

  const videoEl = document.getElementById('videoPreview');
  const audioEl = document.getElementById('audioPreview');
  const startBtn = document.getElementById('startBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const status = document.getElementById('status');
  const progressWrap = document.getElementById('progressWrap');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');

  document.getElementById('videoUrl').textContent = videoUrl;
  document.getElementById('audioUrl').textContent = audioUrl;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  let mediaRecorder = null;
  let recordedChunks = [];

  // ---- Load media ----

  let videoLoaded = false;
  let audioLoaded = false;

  function checkReady() {
    if (videoLoaded && audioLoaded) {
      status.textContent = '\u89C6\u9891\u548C\u97F3\u9891\u5DF2\u52A0\u8F7D\uFF0C\u53EF\u4EE5\u5F00\u59CB\u5408\u6210';
      status.className = 'status success';
      startBtn.disabled = false;
    }
  }

  videoEl.addEventListener('loadedmetadata', () => {
    canvas.width = videoEl.videoWidth || 640;
    canvas.height = videoEl.videoHeight || 360;
    videoLoaded = true;
    checkReady();
  });
  videoEl.addEventListener('error', () => {
    status.textContent = '\u89C6\u9891\u52A0\u8F7D\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u94FE\u63A5\u662F\u5426\u53EF\u8BBF\u95EE';
    status.className = 'status error';
    startBtn.disabled = true;
  });

  audioEl.addEventListener('loadeddata', () => {
    audioLoaded = true;
    checkReady();
  });
  audioEl.addEventListener('error', () => {
    status.textContent = '\u97F3\u9891\u52A0\u8F7D\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u94FE\u63A5\u662F\u5426\u53EF\u8BBF\u95EE';
    status.className = 'status error';
    startBtn.disabled = true;
  });

  let mergeDone = false;

  videoEl.crossOrigin = 'anonymous';
  audioEl.crossOrigin = 'anonymous';
  videoEl.src = videoUrl;
  audioEl.src = audioUrl;

  // ---- Merge logic ----

  function updateProgress(pct, text) {
    progressFill.style.width = pct + '%';
    progressText.textContent = text || Math.round(pct) + '%';
  }

  function startMerge() {
    if (mergeDone) return;
    startBtn.disabled = true;
    progressWrap.style.display = 'block';
    updateProgress(0, '\u51C6\u5907\u4E2D...');
    status.textContent = '\u6B63\u5728\u5408\u6210...';
    status.className = 'status';

    recordedChunks = [];

    // Audio context to mix video's audio track with the external audio
    const audioCtx = new AudioContext();

    // Create destination for mixed audio
    const dest = audioCtx.createMediaStreamDestination();

    // Source 1: external audio file
    const audioSource = audioCtx.createMediaElementSource(audioEl);
    audioSource.connect(dest);

    // Play both media
    videoEl.muted = true; // video's own audio is discarded; we use the external audio source
    videoEl.play();
    audioEl.play();

    // Set up canvas to capture video frames
    const stream = canvas.captureStream(30); // 30 fps
    // Combine canvas video with mixed audio
    const combinedStream = new MediaStream([
      ...stream.getVideoTracks(),
      ...dest.stream.getAudioTracks()
    ]);

    const mimeType = 'video/mp4;codecs=h264,aac';
    const options = MediaRecorder.isTypeSupported(mimeType)
      ? { mimeType }
      : {};

    mediaRecorder = new MediaRecorder(combinedStream, options);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      // Stop media
      videoEl.pause();
      audioEl.pause();
      audioCtx.close();

      const blob = new Blob(recordedChunks, { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);

      mergeDone = true;
      downloadBtn.href = url;
      downloadBtn.download = baseName + '_merged.mp4';
      downloadBtn.style.display = '';
      status.textContent = '\u5408\u6210\u5B8C\u6210\uFF01\u70B9\u51FB\u4E0B\u8F7D\u4FDD\u5B58\u6587\u4EF6';
      status.className = 'status success';
      updateProgress(100, '\u5408\u6210\u5B8C\u6210');
    };

    mediaRecorder.onerror = () => {
      status.textContent = '\u5408\u6210\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u6D4F\u89C8\u5668\u517C\u5BB9\u6027';
      status.className = 'status error';
      startBtn.disabled = false;
    };

    // Render loop: draw video frames to canvas
    let frameCount = 0;
    let lastLog = 0;

    function renderFrame() {
      if (mediaRecorder.state === 'inactive') return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

      frameCount++;

      // Update progress based on video time
      const pct = videoEl.duration > 0
        ? (videoEl.currentTime / videoEl.duration) * 100
        : 0;
      updateProgress(Math.min(pct, 99), '\u5408\u6210\u4E2D ' + Math.round(pct) + '%');

      requestAnimationFrame(renderFrame);
    }

    // Start recording
    mediaRecorder.start(100); // collect data every 100ms

    // When video ends, stop recording
    videoEl.addEventListener('ended', () => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
      }
    }, { once: true });

    renderFrame();

    // Safety timeout: stop after video duration + 2s
    const durationMs = (videoEl.duration || 30) * 1000 + 2000;
    setTimeout(() => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
      }
    }, durationMs);
  }

  startBtn.addEventListener('click', startMerge);

  // Also support downloading via the download button
  downloadBtn.addEventListener('click', () => {
    // Clean up after a moment
    setTimeout(() => {
      URL.revokeObjectURL(downloadBtn.href);
    }, 10000);
  });
})();

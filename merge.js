/**
 * Res-Find 音视频合成页面脚本
 * ============================
 * 使用 MediaRecorder API 在浏览器端将分离的视频和音频流合成为一个文件。
 * 无需服务端支持，纯客户端完成。
 *
 * 工作流程：
 * 1. 从 URL 参数获取视频/音频地址
 * 2. 在隐藏的 <video>/<audio> 元素中加载两个流
 * 3. 使用 Canvas 逐帧绘制视频
 * 4. 使用 AudioContext 将外部音频与视频帧混合
 * 5. 通过 MediaRecorder 录制合并后的 MediaStream
 * 6. 输出 MP4 文件供用户下载
 */

(function() {
  'use strict';

  // 从 URL 查询参数获取视频源、音频源和基础文件名
  const videoUrl = new URLSearchParams(location.search).get('video');
  const audioUrl = new URLSearchParams(location.search).get('audio');
  const baseName = new URLSearchParams(location.search).get('name') || 'merged';

  if (!videoUrl || !audioUrl) {
    document.getElementById('status').textContent = '缺少视频或音频参数';
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

  // ========== 加载媒体资源 ==========

  let videoLoaded = false;
  let audioLoaded = false;

  /** 检查视频和音频是否都已加载完毕 */
  function checkReady() {
    if (videoLoaded && audioLoaded) {
      status.textContent = '视频和音频已加载，可以开始合成';
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
    status.textContent = '视频加载失败，请检查链接是否可访问';
    status.className = 'status error';
    startBtn.disabled = true;
  });

  audioEl.addEventListener('loadeddata', () => {
    audioLoaded = true;
    checkReady();
  });
  audioEl.addEventListener('error', () => {
    status.textContent = '音频加载失败，请检查链接是否可访问';
    status.className = 'status error';
    startBtn.disabled = true;
  });

  let mergeDone = false;

  videoEl.crossOrigin = 'anonymous';
  audioEl.crossOrigin = 'anonymous';
  videoEl.src = videoUrl;
  audioEl.src = audioUrl;

  // ========== 合成逻辑 ==========

  /** 更新合成进度条 */
  function updateProgress(pct, text) {
    progressFill.style.width = pct + '%';
    progressText.textContent = text || Math.round(pct) + '%';
  }

  /** 开始合成：将视频帧和外部音频混合录制为 MP4 */
  function startMerge() {
    if (mergeDone) return;
    startBtn.disabled = true;
    progressWrap.style.display = 'block';
    updateProgress(0, '准备中...');
    status.textContent = '正在合成...';
    status.className = 'status';

    recordedChunks = [];

    // 创建 AudioContext 用于混合音频轨道
    var audioCtx;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      // 浏览器自动播放策略可能导致 AudioContext 处于 suspended 状态
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
    } catch (e) {
      status.textContent = '音频上下文创建失败：' + e.message;
      status.className = 'status error';
      startBtn.disabled = false;
      return;
    }

    // 创建混音输出目标
    var dest = audioCtx.createMediaStreamDestination();

    // 将外部音频文件连接到混音器
    // 注意：createMediaElementSource 在跨域无 CORS 时会抛出 SecurityError
    try {
      var audioSource = audioCtx.createMediaElementSource(audioEl);
      audioSource.connect(dest);
    } catch (e) {
      status.textContent = '音频源连接失败（跨域限制）：' + e.message;
      status.className = 'status error';
      audioCtx.close();
      startBtn.disabled = false;
      return;
    }

    // 播放两个媒体源
    videoEl.muted = true; // 丢弃视频自带的音轨，使用外部音频源
    videoEl.play();
    audioEl.play().catch(function (e) {
      // 音频播放可能被自动播放策略阻止，但不影响合成（AudioContext 接管了音频轨）
      console.warn('音频 play() 被阻止，AudioContext 将接管:', e.message);
    });

    // 用 Canvas 以 30fps 捕获视频帧
    const stream = canvas.captureStream(30);
    // 合并 Canvas 视频流与混音音频流
    const combinedStream = new MediaStream([
      ...stream.getVideoTracks(),
      ...dest.stream.getAudioTracks()
    ]);

    // 优先使用 MP4 编码（h264 视频 + aac 音频），否则回退到浏览器默认格式
    const mimeType = 'video/mp4;codecs=h264,aac';
    const options = MediaRecorder.isTypeSupported(mimeType)
      ? { mimeType }
      : {};

    mediaRecorder = new MediaRecorder(combinedStream, options);

    /** 收集录制的数据块 */
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    /** 录制完成时，生成最终的合并视频文件 */
    mediaRecorder.onstop = () => {
      videoEl.pause();
      audioEl.pause();
      audioCtx.close();

      const blob = new Blob(recordedChunks, { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);

      mergeDone = true;
      downloadBtn.href = url;
      downloadBtn.download = baseName + '_merged.mp4';
      downloadBtn.style.display = '';
      status.textContent = '合成完成！点击下载保存文件';
      status.className = 'status success';
      updateProgress(100, '合成完成');
    };

    /** 录制出错时恢复按钮状态 */
    mediaRecorder.onerror = () => {
      status.textContent = '合成失败，请检查浏览器兼容性';
      status.className = 'status error';
      startBtn.disabled = false;
    };

    // ========== 渲染循环 ==========
    // 逐帧将视频画面绘制到 Canvas 上，模拟视频输出到 MediaStream

    let frameCount = 0;

    /** 渲染帧：将当前视频帧绘制到 Canvas，然后请求下一帧 */
    function renderFrame() {
      if (mediaRecorder.state === 'inactive') return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

      frameCount++;

      // 根据视频进度更新进度条
      const pct = videoEl.duration > 0
        ? (videoEl.currentTime / videoEl.duration) * 100
        : 0;
      updateProgress(Math.min(pct, 99), '合成中 ' + Math.round(pct) + '%');

      requestAnimationFrame(renderFrame);
    }

    // 开始录制，每 100ms 收集一次数据
    mediaRecorder.start(100);

    // 视频播放结束时自动停止录制
    videoEl.addEventListener('ended', () => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
      }
    }, { once: true });

    renderFrame();

    // 安全超时：视频时长 + 2 秒后强制停止（防止卡死）
    const durationMs = (videoEl.duration || 30) * 1000 + 2000;
    setTimeout(() => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
      }
    }, durationMs);
  }

  startBtn.addEventListener('click', startMerge);

  // 下载按钮点击后延迟清理 Blob URL
  downloadBtn.addEventListener('click', () => {
    setTimeout(() => {
      URL.revokeObjectURL(downloadBtn.href);
    }, 10000);
  });
})();

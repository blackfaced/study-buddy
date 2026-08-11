// web/buddy/camera.js
// Buddy 的摄像头相关逻辑（candidate 5 的 camera module）
//
// 包含：
// - openCamera()     — 打开摄像头 + 绑到预览
// - startFrameLoop() — 抓帧 → /api/frame
// - toggleVideo()    — 开关视频模式
// - flipCamera()     — 前后置切换
// - input focus/blur 监听（v0.6.1: 让 iOS 键盘 mic 能用）
//
// 依赖：window.Buddy.state（共享状态）

(function () {
  window.Buddy = window.Buddy || {};
  const S = window.Buddy.state;

window.Buddy.camera = {
  /**
   * Open the camera stream and attach it to the preview element. Reused by
   * requestPerm() (initial setup) and the input-blur handler (v0.6.1:
   * restart after focus-pause so the iOS keyboard mic works).
   *
   * Returns the stream, or null on failure.
   */
  async openCamera() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const hasVideo = devices.some(d => d.kind === 'videoinput');
    try {
      // 只申请 video（不申请 audio），让麦克风给系统输入法用
      const stream = await navigator.mediaDevices.getUserMedia({
        video: hasVideo ? { width: 320, height: 240, facingMode: S.currentFacingMode } : false,
      });
      S.currentStream = stream;
      S.videoStream = stream;
      const video = document.getElementById('cam-preview');
      if (video) {
        video.srcObject = stream;
        if (S.currentFacingMode === 'user') video.classList.add('mirrored');
        await video.play();
      }
      return stream;
    } catch (e) {
      if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') {
        window.Buddy.chat.addSystem('没找到摄像头/麦克风');
      } else if (e.name === 'NotAllowedError') {
        window.Buddy.chat.addSystem('权限被拒绝，点地址栏小锁重新允许');
      } else if (e.name === 'NotReadableError') {
        window.Buddy.chat.addSystem('摄像头被其他 App 占用（关掉 Zoom/FaceTime 再试）');
      } else {
        window.Buddy.chat.addSystem('打开失败：' + e.message);
      }
      return null;
    }
  },

  async startFrameLoop() {
    const DEBUG_MODE = window.Buddy.debugMode;
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');

    let frameCount = 0;
    let lastReadyState = -1;
    let lastVideoId = '';
    let firstError = null;

    // 启动诊断（仅开发模式可见）
    if (DEBUG_MODE) {
      setTimeout(() => {
        const v = document.getElementById('cam-preview');
        if (v) {
          window.Buddy.chat.addSystem(`📷 视频: srcObject=${!!v.srcObject} readyState=${v.readyState} ${v.videoWidth}x${v.videoHeight}`);
        } else {
          window.Buddy.chat.addSystem('⚠️ 没找到视频元素');
        }
      }, 1000);
    }

    S.frameLoop = setInterval(async () => {
      if (S.videoMode === 'off') return;  // 视频模式关了：完全不跑
      const video = document.getElementById('cam-preview');
      if (!video) return;
      if (lastVideoId !== video.id) {
        lastVideoId = video.id;
        if (DEBUG_MODE) window.Buddy.chat.addSystem(`📷 新视频元素 readyState=${video.readyState} ${video.videoWidth}x${video.videoHeight}`);
      }
      if (video.readyState < 2) {
        if (lastReadyState !== video.readyState) {
          lastReadyState = video.readyState;
          if (DEBUG_MODE) window.Buddy.chat.addSystem(`⏳ 摄像头就绪中（readyState=${video.readyState}）`);
        }
        return;
      }
      if (video.videoWidth === 0 || video.videoHeight === 0) {
        // readyState OK 但没实际像素流（静默失败，DEBUG 才显示）
        if (DEBUG_MODE && !firstError) {
          firstError = Date.now();
          window.Buddy.chat.addSystem('⚠️ 视频无像素流（videoWidth=0）');
        }
        return;
      }
      lastReadyState = video.readyState;
      firstError = null;
      try {
        ctx.drawImage(video, 0, 0, 320, 240);
        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.5));
        if (!blob) {
          console.warn('[frame] toBlob null');
          return;
        }
        if (blob.size < 100) {
          console.warn('[frame] blob too small:', blob.size);
          return;
        }
        frameCount++;
        const form = new FormData();
        form.append('frame', blob);
        form.append('sessionId', S.sessionId || '');
        try {
          // v0.7 (issue #21): use shared fetch. FormData is left alone
          // (no Content-Type header so the browser sets the boundary).
          const data = await window.StudyBuddy.fetch('/api/frame', { method: 'POST', body: form });
          if (data.warning) {
            window.Buddy.chat.showWarning(data.warning);
            window.Buddy.chat.addMsg('agent', data.warning);
            window.Buddy.chat.speak(data.warning);
          }
        } catch (e) {
          // 静默失败，不打扰孩子
        }
      } catch (e) {
        console.error('[frame] error:', e);
      }
    }, 500);
  },

  async toggleVideo() {
    const btn = document.getElementById('video-toggle');
    if (S.videoMode === 'on') {
      S.videoMode = 'off';
      btn.textContent = '📹 关';
      btn.title = '视频模式已关（点此打开）';
      // 隐藏摄像头浮窗
      const cam = document.getElementById('cam-preview');
      if (cam) cam.style.display = 'none';
      // 通知 server 不再记 warning
      try { await window.StudyBuddy.fetch('/api/video-mode', { method: 'POST', body: { sessionId: S.sessionId, enabled: false } }); } catch {}
    } else {
      S.videoMode = 'on';
      btn.textContent = '📷 开';
      btn.title = '开关视频模式';
      const cam = document.getElementById('cam-preview');
      if (cam) cam.style.display = '';
      try { await window.StudyBuddy.fetch('/api/video-mode', { method: 'POST', body: { sessionId: S.sessionId, enabled: true } }); } catch {}
    }
  },

  async flipCamera() {
    const newMode = S.currentFacingMode === 'user' ? 'environment' : 'user';

    // 1. 彻底释放老 stream
    if (S.currentStream) {
      S.currentStream.getTracks().forEach(t => t.stop());
      S.currentStream = null;
    }

    // 2. 删掉老 video 元素（Android Chrome 上同一元素切换 facingMode 经常失败）
    const oldVideo = document.getElementById('cam-preview');
    if (oldVideo && oldVideo.parentNode) {
      oldVideo.srcObject = null;
      oldVideo.parentNode.removeChild(oldVideo);
    }

    // 3. 创建新 video 元素
    const newVideo = document.createElement('video');
    newVideo.id = 'cam-preview';
    newVideo.autoplay = true;
    newVideo.muted = true;
    newVideo.playsInline = true;
    if (newMode === 'user') newVideo.classList.add('mirrored');
    document.body.appendChild(newVideo);

    // 4. 等 500ms 让硬件释放
    await new Promise(r => setTimeout(r, 500));

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: newMode },
      });
      S.currentStream = stream;
      S.videoStream = stream; // 同步
      newVideo.srcObject = stream;
      await newVideo.play();
      S.currentFacingMode = newMode;
    } catch (e) {
      window.Buddy.chat.addSystem('切换失败：' + e.message + '（刷新页面重试）');
    }
  },

  /**
   * v0.6.1 + v0.6.3: 让 iOS 键盘的语音按钮 (dictation) 能用。
   * focus → 停视频流；blur → 延迟 2.5s 重启（让 TTS 播完，避免 iOS 抢音频通道）。
   *
   * v0.7 (issue #21): the focus/blur + delayed-resume pattern moved
   * into web/shared/app.js — `StudyBuddy.cameraPause`. We just adapt
   * the buddy-specific side effects here.
   *
   * 必须在 inputEl 拿到后调用。
   */
  attachInputListeners(inputEl) {
    window.StudyBuddy.cameraPause({
      triggerEl: inputEl,
      // The stream to stop on focus. Only pause if video mode is on
      // (otherwise there's nothing to stop).
      getStream: () => (S.videoMode === 'on' ? S.videoStream : null),
      // After the delay, get a fresh stream.
      openCamera: () => this.openCamera(),
      onPause: () => {
        S.videoPausedForInput = true;
        if (S.frameLoop) { clearInterval(S.frameLoop); S.frameLoop = null; }
        S.videoStream = null;
        S.currentStream = null;
      },
      onResume: () => {
        S.videoPausedForInput = false;
        this.startFrameLoop();
      },
      resumeDelayMs: 2500,
    });
  },
};
})();

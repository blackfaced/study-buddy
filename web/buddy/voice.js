// web/buddy/voice.js
// Buddy 的语音 + 拍照逻辑（candidate 5 的 voice module）
//
// 包含：
// - startRecording() / stopRecording() — MediaRecorder 录音 → /api/voice
// - stopMic()                        — 清理 recognition (STT placeholder)
// - enterTextMode()                  — 没摄像头/麦克风时的纯文字模式
// - captureMistake()                 — 拍照 → /api/mistake-photo
//
// 依赖：window.Buddy.state + window.Buddy.chat（addSystem, addMsg, send, startSession）

(function () {
  window.Buddy = window.Buddy || {};
  const S = window.Buddy.state;

  window.Buddy.voice = {
  // ============ Voice (STT placeholder + MediaRecorder) ============

  /**
   * 旧的 STT 用的是 Web Speech API (SpeechRecognition)，
   * 浏览器兼容性差。新版走 MediaRecorder + /api/voice。
   * stopMic() 留作 compatibility stub。
   */
  stopMic() {
    if (S.recognition) {
      try { S.recognition.stop(); } catch (e) { /* ignore */ }
      S.recognition = null;
    }
    S.isListening = false;
    const btn = document.getElementById('mic-btn');
    if (btn) btn.textContent = '🎤 按住说话';
  },

  async startRecording(e) {
    if (e) e.preventDefault();
    if (S.isListening) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      window.Buddy.chat.addSystem('浏览器不支持录音');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
      });
      S.mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm',
      });
      S.audioChunks = [];
      S.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) S.audioChunks.push(e.data);
      };
      S.mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const duration = Date.now() - S.recordingStartTs;
        window.Buddy.chat.addSystem(`🎤 录音 ${(duration / 1000).toFixed(1)} 秒，发送中...`);
        const blob = new Blob(S.audioChunks, { type: 'audio/webm' });
        const form = new FormData();
        form.append('audio', blob, 'voice.webm');
        if (S.sessionId) form.append('sessionId', S.sessionId);
        try {
          // v0.7 (issue #21): use shared fetch (FormData preserved).
          const data = await window.StudyBuddy.fetch('/api/voice', { method: 'POST', body: form });
          if (data.text) {
            window.Buddy.chat.addSystem(`识别结果：${data.text}`);
            const inputEl = document.getElementById('input');
            if (inputEl) inputEl.value = data.text;
            window.Buddy.chat.send();
          } else if (data.error) {
            window.Buddy.chat.addSystem('识别失败：' + data.error);
          }
        } catch (err) {
          window.Buddy.chat.addSystem('发送失败：' + err.message);
        }
      };
      S.mediaRecorder.start();
      S.recordingStartTs = Date.now();
      S.isListening = true;
      const btn = document.getElementById('mic-btn');
      if (btn) btn.textContent = '🛑 松开发送';
      window.Buddy.chat.addSystem('🎤 录音中...');
      // 30 秒自动停
      S.micTimeout = setTimeout(() => {
        if (S.mediaRecorder && S.mediaRecorder.state === 'recording') {
          S.mediaRecorder.stop();
        }
      }, 30000);
    } catch (e) {
      window.Buddy.chat.addSystem('启动录音失败：' + e.name + ' - ' + e.message);
      if (e.name === 'NotAllowedError') {
        window.Buddy.chat.addSystem('需要麦克风权限，点地址栏小锁重新允许');
      }
    }
  },

  stopRecording(e) {
    if (e) e.preventDefault();
    if (S.micTimeout) {
      clearTimeout(S.micTimeout);
      S.micTimeout = null;
    }
    if (S.mediaRecorder && S.mediaRecorder.state === 'recording') {
      S.mediaRecorder.stop();
    }
    this.stopMic();
  },

  // ============ Text-only mode (no device) ============

  async enterTextMode() {
    document.getElementById('no-device-overlay').style.display = 'none';
    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.textContent = '文字模式（无摄像头/麦克风）';
    // 仍然起 session
    try {
      // v0.7 (issue #21): use shared fetch.
      if (!S.sessionId) {
        const data = await window.StudyBuddy.fetch('/api/session/start', {
          method: 'POST',
          body: { childId: 'default', subject: '作业' }
        });
        S.sessionId = data.sessionId;
      }
      S.state = window.Buddy.state.nextState(S.state, 'start');
      window.Buddy.chat.addMsg('agent', '你好呀！我是小书童，文字模式陪你写作业~');
    } catch (e) {
      if (window.Buddy.debugMode) window.Buddy.chat.addSystem('文字模式启动失败: ' + e.message);
    }
  },

  // ============ Mistake photo (v0.5a) ============

  async captureMistake() {
    if (S.photoInFlight) return;
    if (!S.sessionId) {
      window.Buddy.chat.addMsg('agent', '先开始写作业会话再拍题哦～');
      return;
    }
    const video = document.getElementById('cam-preview');
    if (!video || !video.videoWidth) {
      window.Buddy.chat.addMsg('agent', '摄像头还没准备好，先等我看到画面再点 📷');
      return;
    }
    S.photoInFlight = true;
    this.setPhotoBtnState('taking');
    try {
      // Snap a still from the live preview into a JPEG blob
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve, reject) =>
        canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.85)
      );
      const fd = new FormData();
      fd.append('photo', blob, 'mistake.jpg');
      fd.append('sessionId', S.sessionId);
      try {
        // v0.7 (issue #21): use shared fetch. FormData is left alone
        // so the browser sets the multipart boundary. Non-2xx throws.
        const data = await window.StudyBuddy.fetch('/api/mistake-photo', { method: 'POST', body: fd });
        // Show what vision read + the reasoning
        const problemLine = data.problemText ? `我看到：\n${data.problemText}` : '我没看清题目';
        const reasoningLine = data.reasoning ? `\n\n我的思路：\n${data.reasoning}` : '';
        window.Buddy.chat.addMsg('agent', problemLine + reasoningLine);
        this.showPhotoFlash('📷 拍好了');
      } catch (err) {
        const errMsg = (err && err.text)
          ? err.text.slice(0, 80)
          : (err && err.status)
            ? `HTTP ${err.status}`
            : (err && err.message) || 'network error';
        window.Buddy.chat.addMsg('agent', '我没看清，再拍一张试试？');
        if (window.Buddy.debugMode) window.Buddy.chat.addSystem('photo failed: ' + errMsg);
      }
    } catch (e) {
      window.Buddy.chat.addMsg('agent', '拍照没成功，再试一次？');
      if (window.Buddy.debugMode) window.Buddy.chat.addSystem('photo err: ' + e.message);
    } finally {
      S.photoInFlight = false;
      this.setPhotoBtnState('idle');
      // 拍照完自动 focus 到输入框，孩子可以继续问
      setTimeout(() => {
        const inputEl = document.getElementById('input');
        if (inputEl) inputEl.focus();
      }, 300);
    }
  },

  showPhotoFlash(text = '📷 拍好了') {
    const flash = document.createElement('div');
    flash.className = 'photo-flash';
    flash.textContent = text;
    document.body.appendChild(flash);
    void flash.offsetWidth; // force reflow
    flash.classList.add('show');
    setTimeout(() => {
      flash.classList.remove('show');
      setTimeout(() => flash.remove(), 400);
    }, 1800);
  },

  setPhotoBtnState(state) {
    const btn = document.getElementById('photo-btn');
    if (!btn) return;
    if (state === 'taking') {
      btn.disabled = true;
      btn.textContent = '拍照中…';
      btn.style.opacity = '0.6';
    } else {
      btn.disabled = false;
      btn.textContent = '📷';
      btn.style.opacity = '';
    }
  },
};
})();

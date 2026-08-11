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
  const PHOTO_DRAFT_KEY = 'study-buddy.pending-mistake-photo';
  const PHOTO_MAX_BYTES = 500 * 1024;

  function getPhotoFlow() {
    if (S.photoFlow) return S.photoFlow;
    S.photoFlow = window.BuddyPhotoFlow.createPhotoFlow({
      onState: renderPhotoState,
      revokePreview: (url) => URL.revokeObjectURL(url),
      newDraftId: () => {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
          return window.crypto.randomUUID();
        }
        return `draft_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
      },
      saveDraft: (sessionId, draftId) => {
        try { sessionStorage.setItem(PHOTO_DRAFT_KEY, JSON.stringify({ sessionId, draftId })); } catch { /* ignore */ }
      },
      clearDraft: () => {
        try { sessionStorage.removeItem(PHOTO_DRAFT_KEY); } catch { /* ignore */ }
      },
      makeAbortController: () => new AbortController(),
      errorMessage: (error) => {
        if (error && error.status === 413) return '图片太大，请离题目近一点再拍。';
        if (error && error.status === 415) return '图片格式不支持，请重新拍照。';
        if (error && (error.status === 410 || error.status === 504)) return '这次识别已过期，请重新拍照。';
        return '没有分析成功，可以重试或重拍。';
      },
      upload: async (sessionId, draftId, blob, signal) => {
        if (blob.size > PHOTO_MAX_BYTES) {
          const error = new Error('photo exceeds 500 KB');
          error.status = 413;
          throw error;
        }
        const form = new FormData();
        form.append('photo', blob, 'mistake.jpg');
        form.append('sessionId', sessionId);
        form.append('draftId', draftId);
        return window.StudyBuddy.fetch('/api/mistake-photo', { method: 'POST', body: form, signal });
      },
      confirmDraft: (sessionId, draftId, problemText) => window.StudyBuddy.fetch(
        `/api/mistake-photo/${encodeURIComponent(draftId)}/confirm`,
        { method: 'POST', body: { sessionId, problemText } },
      ),
      cancelDraft: (sessionId, draftId) => window.StudyBuddy.fetch(
        `/api/mistake-photo/${encodeURIComponent(draftId)}/cancel`,
        { method: 'POST', body: { sessionId } },
      ),
      restoreDraft: (sessionId, draftId) => window.StudyBuddy.fetch(
        `/api/mistake-photo/${encodeURIComponent(draftId)}?sessionId=${encodeURIComponent(sessionId)}`,
      ),
    });
    return S.photoFlow;
  }

  function renderPhotoState(state) {
    const overlay = document.getElementById('mistake-photo-overlay');
    if (!overlay) return;
    const isOpen = !['idle', 'confirmed'].includes(state.phase);
    overlay.style.display = isOpen ? 'flex' : 'none';
    const preview = document.getElementById('mistake-preview');
    preview.src = state.previewUrl || '';
    preview.style.display = state.previewUrl ? '' : 'none';
    const textarea = document.getElementById('mistake-problem');
    const reviewing = ['review', 'confirming'].includes(state.phase);
    textarea.style.display = reviewing ? '' : 'none';
    if (reviewing && document.activeElement !== textarea) textarea.value = state.problemText || '';
    textarea.disabled = state.phase === 'confirming';
    document.getElementById('mistake-preview-actions').style.display = reviewing ? 'none' : 'flex';
    document.getElementById('mistake-review-actions').style.display = reviewing ? 'flex' : 'none';
    document.getElementById('mistake-analyze').disabled = state.phase === 'analyzing';
    document.getElementById('mistake-confirm').disabled = state.phase === 'confirming';
    const cancelling = state.phase === 'cancelling';
    document.getElementById('mistake-preview-cancel').disabled = cancelling;
    document.getElementById('mistake-retake').disabled = cancelling;
    document.getElementById('mistake-review-cancel').disabled = cancelling || state.phase === 'confirming';
    document.getElementById('mistake-photo-error').textContent = state.error || '';
    const status = document.getElementById('mistake-photo-status');
    if (state.phase === 'analyzing') status.textContent = '正在读题，请稍等…';
    else if (reviewing) status.textContent = '请检查文字；有不对的地方可以直接改。';
    else status.textContent = '确认清楚后，再让小书童读题。';
  }

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
      const blob = await captureBoundedJpeg(video);
      getPhotoFlow().preview(blob, URL.createObjectURL(blob));
    } catch (e) {
      window.Buddy.chat.addMsg(
        'agent',
        e && e.status === 413 ? '图片太大，请离题目近一点再拍。' : '拍照没成功，再试一次？',
      );
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

  async retakePhoto() {
    if (!await getPhotoFlow().retake(S.sessionId)) return;
    setTimeout(() => this.captureMistake(), 0);
  },

  async cancelPhoto() {
    await getPhotoFlow().cancel(S.sessionId);
  },

  async analyzePhoto() {
    await getPhotoFlow().analyze(S.sessionId);
  },

  async confirmPhoto() {
    const textarea = document.getElementById('mistake-problem');
    const problemText = textarea ? textarea.value : '';
    if (!problemText.trim()) {
      document.getElementById('mistake-photo-error').textContent = '请先把题目文字补完整。';
      return;
    }
    const confirmed = await getPhotoFlow().confirm(S.sessionId, problemText);
    if (confirmed) {
      window.Buddy.chat.addMsg('agent', `已记录：\n${problemText.trim()}`);
      this.showPhotoFlash('已确认记录');
      getPhotoFlow().resetConfirmed();
    }
  },

  async restorePendingMistake() {
    if (!S.sessionId || getPhotoFlow().state.phase !== 'idle') return;
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(PHOTO_DRAFT_KEY) || 'null'); } catch { /* ignore */ }
    if (!saved || saved.sessionId !== S.sessionId || !saved.draftId) return;
    const restored = await getPhotoFlow().restore(S.sessionId, saved.draftId);
    if (restored && getPhotoFlow().state.phase === 'confirmed') {
      window.Buddy.chat.addMsg('agent', '这道题已经记录过了。');
      getPhotoFlow().resetConfirmed();
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

  async function captureBoundedJpeg(video) {
    const sizeSteps = [1280, 960, 720];
    const qualities = [0.78, 0.6, 0.42];
    for (const maxEdge of sizeSteps) {
      const scale = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      for (const quality of qualities) {
        const blob = await new Promise((resolve, reject) =>
          canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', quality)
        );
        if (blob.size <= PHOTO_MAX_BYTES) return blob;
      }
    }
    const error = new Error('photo exceeds 500 KB');
    error.status = 413;
    throw error;
  }
})();

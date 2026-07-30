// web/buddy/chat.js
// Buddy 的 chat + session + TTS 逻辑（candidate 5 的 chat module）
//
// 包含：
// - addMsg / addSystem / showWarning（UI helpers，所有 module 都要用）
// - speak()                          — iOS Safari TTS unlock + 暖机
// - send()                           — 发消息 → /api/chat → 朗读
// - requestPerm()                    — 首次授权 + 开 session + welcome
// - startSession() / endSession()    — 写完切换
//
// 依赖：window.Buddy.state + window.Buddy.camera

(function () {
  window.Buddy = window.Buddy || {};
  const S = window.Buddy.state;

  // ----- DOM refs 缓存（init 时由顶层 inline 设置）-----
  let _chatEl = null;
  let _statusEl = null;
  let _avatarEl = null;
  let _inputEl = null;

  window.Buddy.chat = {
  /**
   * 顶层 inline script 在 DOMContentLoaded 之前调用一次，注入需要的元素。
   * 这样模块不直接调 document.getElementById（除了 chatEl 这种稳定元素）。
   */
  init(els) {
    _chatEl = els.chatEl;
    _statusEl = els.statusEl;
    _avatarEl = els.avatarEl;
    _inputEl = els.inputEl;
  },

  // ============ UI helpers ============

  addMsg(role, text) {
    if (!_chatEl) return;
    const div = document.createElement('div');
    div.className = 'msg msg-' + role;
    div.textContent = text;
    _chatEl.appendChild(div);
    _chatEl.scrollTop = _chatEl.scrollHeight;
    if (role === 'agent' && _avatarEl) {
      _avatarEl.classList.add('happy');
      setTimeout(() => _avatarEl.classList.remove('happy'), 500);
    }
  },

  addSystem(text) {
    if (!_chatEl) return;
    const div = document.createElement('div');
    div.className = 'msg msg-system';
    div.textContent = text;
    _chatEl.appendChild(div);
    _chatEl.scrollTop = _chatEl.scrollHeight;
  },

  showWarning(text) {
    if (!_chatEl) return;
    const div = document.createElement('div');
    div.className = 'warning';
    div.textContent = text;
    _chatEl.appendChild(div);
    setTimeout(() => div.remove(), 4000);
    if (_avatarEl) {
      _avatarEl.classList.add('happy');
      setTimeout(() => _avatarEl.classList.remove('happy'), 800);
    }
  },

  // ============ TTS ============

  /**
   * iOS Safari 必须在用户交互后才能 speak。
   * v0.6.4 修正: 每次 send() 同步窗口里都 speak 一个静音 utterance 把
   * speech engine "暖"起来，await fetch 之后 speak(reply) 才不会
   * 因为 gesture context 过期而静默 fail。
   */
  speak(text) {
    if (!('speechSynthesis' in window)) return;
    if (S.synthUnlocked === false) {
      // v0.7 (issue #21): central warmup so every app gets the same fix.
      window.StudyBuddy.warmupTTS();
      S.synthUnlocked = true;
    }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = 0.9;
    u.pitch = 1.1;
    // iOS 经常需要先 cancel 再 speak，否则新 utterance 不发声
    speechSynthesis.cancel();
    setTimeout(() => {
      speechSynthesis.speak(u);
    }, 50);
    u.onerror = (e) => {
      console.warn('TTS error:', e);
    };
  },

  // ============ Chat send ============

  async send() {
    if (!_inputEl) return;
    const text = _inputEl.value.trim();
    if (!text) return;
    _inputEl.value = '';
    this.addMsg('child', text);

    // v0.6.4: iOS Safari — 在 user gesture 的同步窗口里先 speak 一个静音
    // utterance，把 speech engine "暖"起来。await fetch 之后 speak(reply)
    // 才不会因为 gesture context 过期而静默 fail。
    // v0.7 (issue #21): extracted to web/shared/app.js.
    window.StudyBuddy.warmupTTS();

    // done 状态下，孩子说"我要写作业"自动切回 writing 模式
    if (S.state === 'done' && /我要(写|做)作业|继续写|再写|接着写|想写作业|还要写/i.test(text)) {
      await this.startSession();
      return;
    }

    try {
      // v0.7 (issue #21): use shared fetch (sets Content-Type + parses JSON,
      // throws on non-2xx so we can rely on `e.status`).
      const { reply } = await window.StudyBuddy.fetch('/api/chat', {
        method: 'POST',
        body: { text, state: S.state }
      });
      this.addMsg('agent', reply);
      this.speak(reply);
    } catch (e) {
      this.addSystem('chat 失败: ' + e.message);
      this.addMsg('agent', '网络不好，再说一次？');
    }
  },

  // ============ Device check (start flow) ============

  async checkDevices() {
    const info = {
      hasVideo: false,
      hasAudio: false,
      apiAvailable: false,
      devices: [],
      error: null,
      userAgent: navigator.userAgent,
      isSecureContext: window.isSecureContext,
    };
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        info.error = 'mediaDevices API 不可用';
        return info;
      }
      info.apiAvailable = true;
      const devices = await navigator.mediaDevices.enumerateDevices();
      info.devices = devices.map(d => ({
        kind: d.kind,
        label: d.label || '(无 label — 需要先授权)',
        deviceId: d.deviceId.slice(0, 8) + '...',
      }));
      info.hasVideo = devices.some(d => d.kind === 'videoinput');
      info.hasAudio = devices.some(d => d.kind === 'audioinput');
    } catch (e) {
      info.error = e.name + ': ' + e.message;
    }
    return info;
  },

  showNoDevice(info) {
    document.getElementById('no-device-title').textContent =
      info.hasVideo || info.hasAudio ? '只有部分设备' : '没检测到摄像头/麦克风';

    // 调试信息
    const debugEl = document.getElementById('device-debug');
    if (debugEl) debugEl.textContent = JSON.stringify(info, null, 2);

    // 提示
    const hints = [];
    if (!info.apiAvailable) {
      hints.push('❌ 浏览器不支持 mediaDevices API（试试 Chrome / Safari 最新版）');
    }
    if (info.error) {
      hints.push(`❌ 错误：${info.error}`);
    }
    if (info.apiAvailable && !info.hasVideo) {
      hints.push('❌ 没找到摄像头。Mac Pro 没有内置摄像头，需要外接 USB 摄像头或在 iPhone 上打开');
    }
    if (info.isSecureContext === false) {
      hints.push('❌ 不是 secure context（应该用 https:// 或 localhost 或 mac-mini.local）');
    }
    if (hints.length === 0 && !info.hasVideo && !info.hasAudio) {
      hints.push('可能的解决：');
      hints.push('1. macOS 系统设置 → 隐私与安全性 → 摄像头 → 允许 Chrome');
      hints.push('2. 系统设置 → 麦克风 → 允许 Chrome');
      hints.push('3. 摄像头没被其他 App 占用（Zoom / FaceTime / OBS）');
      hints.push('4. 用孩子的 iPhone / iPad / Android 手机打开（推荐）');
    }

    const hintEl = document.getElementById('no-device-hint');
    if (hintEl) hintEl.innerHTML = hints
      .map(h => `<div style="text-align:left;margin:4px 0;font-size:14px;line-height:1.5;">${h}</div>`)
      .join('');

    document.getElementById('no-device-overlay').style.display = 'flex';
  },

  async retryDeviceCheck() {
    document.getElementById('no-device-overlay').style.display = 'none';
    const info = await this.checkDevices();
    if (info.hasVideo || info.hasAudio) {
      document.getElementById('perm-overlay').style.display = 'flex';
    } else {
      this.showNoDevice(info);
    }
  },

  // ============ Session lifecycle ============

  async requestPerm() {
    document.getElementById('perm-overlay').style.display = 'none';

    // v0.6.4: 同 send() 的修法 — 在 user gesture 同步窗口里先 speak 静音
    // utterance。否则 await openCamera() + await fetch 之后 welcome speak
    // 会因为 gesture 过期静默 fail。
    // v0.7 (issue #21): extracted to web/shared/app.js.
    window.StudyBuddy.warmupTTS();

    await window.Buddy.camera.openCamera();

    // 开 session
    try {
      // v0.7 (issue #21): use shared fetch.
      const data = await window.StudyBuddy.fetch('/api/session/start', {
        method: 'POST',
        body: { childId: 'default', subject: '作业' }
      });
      S.sessionId = data.sessionId;
      S.state = window.Buddy.state.nextState(S.state, 'start');
      if (_statusEl) _statusEl.textContent = '写作业中...';
      this.addMsg('agent', '你好呀！我是小书童，我们开始写作业吧~');
      this.speak('你好呀！我是小书童，我们开始写作业吧');
    } catch (e) {
      if (_statusEl) _statusEl.textContent = '会话启动失败';
      return;
    }

    // 启动坐姿循环
    window.Buddy.camera.startFrameLoop();
  },

  async startSession() {
    if (S.state === 'writing') return;
    try {
      // v0.7 (issue #21): use shared fetch.
      const data = await window.StudyBuddy.fetch('/api/session/start', { method: 'POST' });
      S.sessionId = data.sessionId;
      S.state = window.Buddy.state.nextState(S.state, 'start');
      if (!S.frameLoop && S.videoStream) {
        // 已经在 idle/done 时保留了 stream？不应该，endSession 已停 stream
        // 这里重新启动摄像头
      }
      // 重新启动摄像头
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        try {
          S.videoStream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, facingMode: S.currentFacing } });
          const v = document.getElementById('cam-preview');
          v.srcObject = S.videoStream;
          await v.play();
          window.Buddy.camera.startFrameLoop();
        } catch (e) {
          // 摄像头开不动（拒绝 / 设备占着），不打扰，进入纯聊天模式
        }
      }
      this.addMsg('agent', '好嘞，继续写！');
      this.speak('好嘞继续写');
      if (_statusEl) _statusEl.textContent = '写作业中...';
    } catch (e) {
      if (window.Buddy.debugMode) this.addSystem('启动失败: ' + e.message);
    }
  },

  async endSession() {
    if (S.state !== 'writing') {
      return;
    }
    try {
      // v0.7 (issue #21): use shared fetch.
      const data = await window.StudyBuddy.fetch('/api/session/end', { method: 'POST' });
      this.addMsg('agent', '写完啦！');
      this.speak('写完啦');
      // 克制的小结：时长 + 专注分 + 警告次数（不评价好坏）
      if (data.durationMin) {
        const parts = [`今天写了 ${data.durationMin} 分钟`];
        if (data.avgFocusScore != null) parts.push(`专注 ${data.avgFocusScore} 分`);
        if (data.postureWarningCount > 0) parts.push(`${data.postureWarningCount} 次坐姿提醒`);
        this.addSystem(parts.join(' · '));
      }
      if (S.frameLoop) { clearInterval(S.frameLoop); S.frameLoop = null; }
      if (S.videoStream) {
        S.videoStream.getTracks().forEach(t => t.stop());
        S.videoStream = null;
      }
      S.state = window.Buddy.state.nextState(S.state, 'end');
      if (_statusEl) _statusEl.textContent = '写完啦，可以跟小书童聊会儿~';
    } catch (e) {
      if (window.Buddy.debugMode) this.addSystem('结束失败: ' + e.message);
    }
  },
};
})();

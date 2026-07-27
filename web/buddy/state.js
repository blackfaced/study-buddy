// web/buddy/state.js
// Buddy 的可变状态集中地（candidate 5 的 state module）
//
// 所有状态变量原封不动从 inline script 搬过来，外部只通过
// window.Buddy.state 读写，不暴露裸 let。
//
// 状态机：
//   'idle'   — 还没开始写作业
//   'writing'— 写作业中
//   'done'   — 写完了，可以聊天
//
// 视频模式：
//   'on'     — 跑 frame loop + 警告
//   'off'    — 完全不跑
//
// 摄像头朝向：
//   'user'       — 前置
//   'environment'— 后置（默认，孩子用）

window.Buddy = window.Buddy || {};

window.Buddy.state = {
  // 会话
  sessionId: null,
  state: 'idle', // 'idle' | 'writing' | 'done'

  // 视频
  videoMode: 'on', // 'on' | 'off'
  frameLoop: null,
  videoStream: null,    // = currentStream 别名，统一引用
  currentStream: null,
  currentFacing: 'environment', // 默认后置
  currentFacingMode: 'environment',
  videoPausedForInput: false, // v0.6.1: 临时暂停让 iOS 键盘 mic 能用
  resumeCameraTimer: null,   // v0.6.3: 延迟重启避开 TTS mute

  // TTS (iOS Safari 解锁)
  synthUnlocked: false,

  // 语音 (STT placeholder + MediaRecorder)
  recognition: null,
  isListening: false,
  mediaRecorder: null,
  audioChunks: [],
  micTimeout: null,
  recordingStartTs: 0,

  // 拍照
  photoInFlight: false,
};

/**
 * 状态机转移：根据当前 state + 事件算下一个 state。
 * 抽出成纯函数方便测试。
 *
 * 事件：
 *   'start'  — 请求开始写作业
 *   'end'    — 写完
 *   'restart'— "我要写作业" 类消息触发回到 writing
 *
 * @param {string} current - 'idle' | 'writing' | 'done'
 * @param {string} event   - 'start' | 'end' | 'restart'
 * @returns {string} next state
 */
window.Buddy.state.nextState = function (current, event) {
  if (event === 'start') {
    // 从任何状态都能起一个新 session
    return 'writing';
  }
  if (event === 'end') {
    if (current !== 'writing') return current; // 只有 writing 能 end
    return 'done';
  }
  if (event === 'restart') {
    if (current === 'done') return 'writing';
    return current;
  }
  return current;
};

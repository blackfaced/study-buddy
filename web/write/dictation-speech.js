// web/write/dictation-speech.js
// =====================================================================
// Dictation TTS — thin wrapper over the browser's speechSynthesis
// (issue #196). zh-CN only, zero backend dependency; iPad Safari
// supports it. No server-side TTS.
//
// Public API:
//   createSpeaker({ synth, Utterance, lang, rate })
//     .speakItem(text, times) — cancel current queue, then enqueue the
//                               text `times` times; false if unsupported
//     .stop()                 — cancel anything queued/playing
// =====================================================================

export function createSpeaker({ synth, Utterance, lang = "zh-CN", rate = 0.9 }) {
  const supported = !!synth && typeof Utterance === "function";

  function speakItem(text, times) {
    if (!supported || !text) return false;
    synth.cancel();
    for (let i = 0; i < times; i += 1) {
      const u = new Utterance(text);
      u.lang = lang;
      u.rate = rate;
      synth.speak(u);
    }
    return true;
  }

  function stop() {
    if (supported) synth.cancel();
  }

  return { speakItem, stop };
}

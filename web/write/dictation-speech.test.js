// web/write/dictation-speech.test.js
//
// Behavior tests for the dictation TTS wrapper (issue #196).
// Browser speechSynthesis, zh-CN, zero backend dependency.
//
// Run: node --test web/write/dictation-speech.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSpeaker } from "./dictation-speech.js";

function stubSynth() {
  const spoken = [];
  return {
    spoken,
    cancelled: 0,
    speak(u) { spoken.push(u); },
    cancel() { this.cancelled += 1; },
  };
}

function stubUtterance() {
  return class {
    constructor(text) { this.text = text; }
  };
}

function makeSpeaker() {
  const synth = stubSynth();
  const speaker = createSpeaker({ synth, Utterance: stubUtterance() });
  return { synth, speaker };
}

test("speakItem enqueues the item text exactly `times` times, zh-CN", () => {
  const { synth, speaker } = makeSpeaker();
  speaker.speakItem("苹果", 2);
  assert.equal(synth.spoken.length, 2);
  assert.ok(synth.spoken.every((u) => u.text === "苹果" && u.lang === "zh-CN"));
});

test("a fresh speakItem cancels the previous queue first (重听 interrupts)", () => {
  const { synth, speaker } = makeSpeaker();
  speaker.speakItem("苹果", 2);
  assert.equal(synth.cancelled, 1); // initial clear
  speaker.speakItem("苹果", 1);
  assert.equal(synth.cancelled, 2); // interrupted the first queue
  assert.equal(synth.spoken.length, 3);
});

test("stop() cancels any queued speech", () => {
  const { synth, speaker } = makeSpeaker();
  speaker.speakItem("我爱吃水果。", 3);
  speaker.stop();
  assert.equal(synth.cancelled, 2); // speakItem's clear + stop
});

test("missing synth (no TTS support) degrades quietly", () => {
  const speaker = createSpeaker({ synth: null, Utterance: stubUtterance() });
  assert.equal(speaker.speakItem("苹果", 2), false);
  speaker.stop(); // must not throw
});

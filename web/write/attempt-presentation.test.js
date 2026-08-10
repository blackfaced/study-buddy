import { test } from "node:test";
import assert from "node:assert/strict";
import { presentationForAttempt } from "./attempt-presentation.js";

test("an independent retry starts on a blank grid without replaying the reference", () => {
  assert.deepEqual(presentationForAttempt({ independentRetry: true }), {
    showCharacter: false,
    animateReference: false,
    initialPhase: "writing",
    status: "现在不看提示，独立写一次",
    allowReplay: false,
  });
});

test("an ordinary or placement follow-up attempt still begins with observation", () => {
  assert.equal(presentationForAttempt({}).animateReference, true);
  assert.equal(
    presentationForAttempt({ independentRetry: false, followupRetry: true }).showCharacter,
    true,
  );
});

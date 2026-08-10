import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildVisualReviewPayload,
  childFacingVisualSuggestion,
} from "./visual-review.js";

test("ordinary attempts do not build a visual-review request", () => {
  const payload = buildVisualReviewPayload({
    assessment: { reviewRecommended: false, breakdown: { structure: 0.9 } },
    imageBase64: "current-character-only",
  });

  assert.equal(payload, null);
});

test("visual-review payload contains only the current crop and structure signal", () => {
  const payload = buildVisualReviewPayload({
    assessment: {
      reviewRecommended: true,
      band: "基本正确",
      breakdown: { structure: 0.6, placement: 0.4, strokeQuality: 0.8, shape: 0.7 },
      reasons: [{ code: "stroke_order_wrong", message: "笔顺错误" }],
    },
    imageBase64: "current-character-only",
  });

  assert.deepEqual(payload, {
    imageBase64: "current-character-only",
    localAssessment: { breakdown: { structure: 0.6 } },
  });
});

test("model advice can fill the second feedback slot but never creates a third", () => {
  const review = { status: "completed", suggestion: "左右再靠近一点" };

  assert.equal(
    childFacingVisualSuggestion({ primaryReason: { code: "structure" }, secondaryReason: null }, review),
    "左右再靠近一点",
  );
  assert.equal(
    childFacingVisualSuggestion(
      { primaryReason: { code: "structure" }, secondaryReason: { code: "stroke" } },
      review,
    ),
    null,
  );
});

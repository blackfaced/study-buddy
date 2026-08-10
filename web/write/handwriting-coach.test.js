import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createHandwritingCoach,
  referenceFromHanziData,
} from "./handwriting-coach.js";

const reference = {
  strokes: [
    [
      { x: 180, y: 260 },
      { x: 420, y: 260 },
    ],
    [
      { x: 300, y: 160 },
      { x: 300, y: 440 },
    ],
  ],
};

test("a complete canonical attempt receives an explainable top-band assessment", () => {
  const coach = createHandwritingCoach({ reference, stageSize: 600 });
  const result = coach.assess({ strokes: reference.strokes, process: {} });

  assert.equal(result.status, "scored");
  assert.equal(result.canSubmit, true);
  assert.equal(result.band, "写得很好");
  assert.equal(result.score, 100);
  assert.deepEqual(result.breakdown, {
    structure: 1,
    placement: 1,
    strokeQuality: 1,
    shape: 1,
  });
  assert.equal(result.primaryReason, null);
  assert.equal(result.algorithmVersion, "handwriting-coach-v1");
});

test("grid placement tolerates three percent drift but explains ten percent drift", () => {
  const coach = createHandwritingCoach({ reference, stageSize: 600 });
  const shift = (amount) =>
    reference.strokes.map((stroke) =>
      stroke.map((point) => ({ x: point.x + amount, y: point.y })),
    );

  const natural = coach.assess({ strokes: shift(18), process: {} });
  const obvious = coach.assess({ strokes: shift(60), process: {} });

  assert.equal(natural.breakdown.placement, 1);
  assert.notEqual(natural.primaryReason?.code, "placement_right");
  assert.ok(obvious.breakdown.placement < 0.75);
  assert.equal(obvious.primaryReason.code, "placement_right");
  assert.match(obvious.primaryReason.message, /左一点/);
});

test("poor proportions are explained before lower-priority stroke-shape differences", () => {
  const coach = createHandwritingCoach({ reference, stageSize: 600 });
  const narrowTopStroke = [
    [
      { x: 270, y: 260 },
      { x: 330, y: 260 },
    ],
    reference.strokes[1],
  ];

  const result = coach.assess({ strokes: narrowTopStroke, process: {} });

  assert.ok(result.breakdown.structure < 0.75);
  assert.equal(result.primaryReason.code, "structure_proportion");
  assert.match(result.primaryReason.message, /宽窄|高低/);
  assert.equal(result.reviewRecommended, true);
});

test("a nearly horizontal one-stroke character is not punished for harmless pen jitter", () => {
  const oneStroke = {
    strokes: [
      [
        { x: 140, y: 300 },
        { x: 460, y: 300 },
      ],
    ],
  };
  const coach = createHandwritingCoach({
    reference: oneStroke,
    stageSize: 600,
  });
  const result = coach.assess({
    strokes: [
      [
        { x: 142, y: 298 },
        { x: 300, y: 304 },
        { x: 458, y: 299 },
      ],
    ],
    process: {},
  });

  assert.ok(result.breakdown.structure >= 0.8);
  assert.notEqual(result.primaryReason?.code, "structure_proportion");
});

test("a recognisable later stroke is rejected immediately as an order error", () => {
  const coach = createHandwritingCoach({ reference, stageSize: 600 });
  const decision = coach.reviewStroke({
    acceptedStrokes: [],
    candidate: reference.strokes[1],
    errorCounts: {},
  });

  assert.equal(decision.status, "incorrect");
  assert.equal(decision.accept, false);
  assert.equal(decision.remove, true);
  assert.equal(decision.reason.code, "stroke_order_wrong");
  assert.equal(decision.expectedStrokeIndex, 0);
  assert.equal(decision.matchedStrokeIndex, 1);
  assert.ok(decision.confidence >= 0.8);
  assert.equal(decision.hint.level, 1);
  assert.deepEqual(decision.hint.points, reference.strokes[0]);
});

test("a clearly reversed current stroke is rejected while mild child jitter is accepted", () => {
  const coach = createHandwritingCoach({ reference, stageSize: 600 });
  const reversed = coach.reviewStroke({
    acceptedStrokes: [],
    candidate: [...reference.strokes[0]].reverse(),
    errorCounts: {},
  });
  const jittered = coach.reviewStroke({
    acceptedStrokes: [],
    candidate: [
      { x: 181, y: 263 },
      { x: 240, y: 257 },
      { x: 302, y: 264 },
      { x: 360, y: 258 },
      { x: 418, y: 262 },
    ],
    errorCounts: {},
  });

  assert.equal(reversed.status, "incorrect");
  assert.equal(reversed.reason.code, "stroke_direction_reversed");
  assert.equal(reversed.accept, false);
  assert.equal(jittered.status, "correct");
  assert.equal(jittered.accept, true);
});

test("repeated errors escalate from location to direction to animation", () => {
  const coach = createHandwritingCoach({ reference, stageSize: 600 });
  const wrong = reference.strokes[1];
  const levels = [0, 1, 2].map(
    (count) =>
      coach.reviewStroke({
        acceptedStrokes: [],
        candidate: wrong,
        errorCounts: { 0: count },
      }).hint,
  );

  assert.deepEqual(
    levels.map((hint) => hint.level),
    [1, 2, 3],
  );
  assert.equal(levels[0].showDirection, false);
  assert.equal(levels[1].showDirection, true);
  assert.equal(levels[2].animate, true);
});

test("guided errors require one independent rewrite without creating an infinite loop", () => {
  const coach = createHandwritingCoach({ reference, stageSize: 600 });
  const guided = coach.assess({
    strokes: reference.strokes,
    process: { orderErrors: 1, rejectedStrokes: 1, independentRetry: false },
  });
  const independentFailure = coach.assess({
    strokes: reference.strokes,
    process: { orderErrors: 1, rejectedStrokes: 1, independentRetry: true },
  });

  assert.equal(guided.band, "写得规范");
  assert.equal(guided.primaryReason.code, "stroke_order_wrong");
  assert.equal(guided.nextAction, "independent_retry");
  assert.equal(independentFailure.nextAction, "review_later");
  assert.equal(independentFailure.requiresIndependentRetry, false);
});

test("a character more than fifteen percent off-center requires one rewrite, not a loop", () => {
  const coach = createHandwritingCoach({ reference, stageSize: 600 });
  const shifted = reference.strokes.map((stroke) =>
    stroke.map((point) => ({ x: point.x + 120, y: point.y })),
  );
  const first = coach.assess({ strokes: shifted, process: {} });
  const followup = coach.assess({
    strokes: shifted,
    process: { followupRetry: true },
  });

  assert.equal(first.primaryReason.code, "placement_right");
  assert.equal(first.requiresRewrite, true);
  assert.equal(first.requiresRetry, true);
  assert.equal(first.nextAction, "rewrite");
  assert.equal(followup.requiresRetry, false);
  assert.equal(followup.nextAction, "review_later");
});

test("missing strokes block submission and extra strokes are rejected immediately", () => {
  const coach = createHandwritingCoach({ reference, stageSize: 600 });
  const missing = coach.assess({
    strokes: [reference.strokes[0]],
    process: {},
  });
  const extra = coach.reviewStroke({
    acceptedStrokes: reference.strokes,
    candidate: [
      { x: 20, y: 20 },
      { x: 40, y: 40 },
    ],
    errorCounts: {},
  });

  assert.equal(missing.canSubmit, false);
  assert.equal(missing.primaryReason.code, "stroke_missing");
  assert.deepEqual(missing.nextStroke, reference.strokes[1]);
  assert.equal(extra.accept, false);
  assert.equal(extra.reason.code, "stroke_extra");
});

test("HanziWriter medians become ordered stage-space reference strokes", () => {
  const converted = referenceFromHanziData(
    {
      strokes: ["M 0 0"],
      medians: [
        [
          [0, 0],
          [1024, 1024],
        ],
      ],
    },
    { stageSize: 600, padding: 100 },
  );

  assert.deepEqual(converted.strokes, [
    [
      { x: 100, y: 500 },
      { x: 500, y: 100 },
    ],
  ]);
});

test("validated variants are recorded as stroke indexes, not natural-language rules", () => {
  const converted = referenceFromHanziData(
    {
      medians: [
        [
          [0, 512],
          [1024, 512],
        ],
        [
          [512, 1024],
          [512, 0],
        ],
      ],
    },
    { stageSize: 600, padding: 100, variantOrders: [[1, 0]] },
  );

  assert.deepEqual(converted.variants, [
    {
      strokes: [converted.strokes[1], converted.strokes[0]],
    },
  ]);
});

test("missing reference data is unscorable and never becomes a child failure", () => {
  const coach = createHandwritingCoach({
    reference: { strokes: [] },
    stageSize: 600,
  });
  const result = coach.assess({ strokes: reference.strokes, process: {} });

  assert.equal(result.status, "unscorable");
  assert.equal(result.canSubmit, true);
  assert.equal(result.score, null);
  assert.equal(result.band, "暂时无法判断");
  assert.equal(result.primaryReason.code, "reference_unavailable");
  assert.equal(result.reasons[0].code, "reference_unavailable");
});

test("an explicitly validated stroke-order variant is accepted without weakening the canonical rule", () => {
  const coach = createHandwritingCoach({
    reference: {
      ...reference,
      variants: [{ strokes: [reference.strokes[1], reference.strokes[0]] }],
    },
    stageSize: 600,
  });

  const decision = coach.reviewStroke({
    acceptedStrokes: [],
    candidate: reference.strokes[1],
    errorCounts: {},
  });

  assert.equal(decision.status, "correct");
  assert.equal(decision.accept, true);
});

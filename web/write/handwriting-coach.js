export const ALGORITHM_VERSION = "handwriting-coach-v1";

// Only add a character here after an adult has checked the variant against
// an authoritative source. Each entry is an array of zero-based stroke-order
// permutations; natural-language descriptions are deliberately not parsed.
export const VALIDATED_STROKE_ORDERS = Object.freeze({});

export const DEFAULT_HANDWRITING_POLICY = Object.freeze({
  placementNatural: 0.03,
  placementMinor: 0.08,
  placementMajor: 0.15,
  weights: Object.freeze({
    structure: 0.3,
    placement: 0.25,
    strokeQuality: 0.25,
    shape: 0.2,
  }),
  strokeMatch: Object.freeze({
    priorStroke: 0.5,
    correct: 0.58,
    laterStroke: 0.78,
    laterStrokeMargin: 0.2,
    reversed: 0.82,
    reversedMargin: 0.18,
  }),
  bands: Object.freeze({ basic: 55, standard: 75, great: 90 }),
  reasonThresholds: Object.freeze({
    structure: 0.75,
    strokeQuality: 0.72,
    shape: 0.7,
  }),
  review: Object.freeze({
    structureMin: 0.35,
    structureMax: 0.8,
    bandWindow: 4,
  }),
  hints: Object.freeze({ startDirectionAt: 2, animateAt: 3, maxLevel: 3 }),
});

export function referenceFromHanziData(
  characterData,
  {
    stageSize = 600,
    padding = 100,
    sourceSize = 1024,
    variantOrders = [],
  } = {},
) {
  if (
    !Array.isArray(characterData?.medians) ||
    characterData.medians.length === 0 ||
    (Array.isArray(characterData?.strokes) &&
      characterData.strokes.length !== characterData.medians.length)
  ) {
    return { strokes: [] };
  }
  const scale = (stageSize - padding * 2) / sourceSize;
  const strokes = characterData.medians.map((median) =>
    Array.isArray(median)
      ? median
          .map((point) => ({
            x: padding + Number(point?.[0]) * scale,
            y: stageSize - padding - Number(point?.[1]) * scale,
          }))
          .filter(
            (point) => Number.isFinite(point.x) && Number.isFinite(point.y),
          )
      : [],
  );
  const variants = variantOrders
    .filter((order) => isStrokeOrderPermutation(order, strokes.length))
    .map((order) => ({ strokes: order.map((index) => strokes[index]) }));
  return {
    strokes,
    ...(variants.length > 0 ? { variants } : {}),
  };
}

function isStrokeOrderPermutation(order, strokeCount) {
  return (
    Array.isArray(order) &&
    order.length === strokeCount &&
    new Set(order).size === strokeCount &&
    order.every(
      (index) => Number.isInteger(index) && index >= 0 && index < strokeCount,
    )
  );
}

export function createHandwritingCoach({
  reference,
  stageSize = 600,
  policy = {},
}) {
  const config = mergePolicy(policy);
  const rawReferenceStrokes = Array.isArray(reference?.strokes) ? reference.strokes : [];
  const normalizedReferenceStrokes = normalizeStrokes(rawReferenceStrokes);
  const referenceStrokes =
    normalizedReferenceStrokes.length === rawReferenceStrokes.length &&
    normalizedReferenceStrokes.every((stroke) => stroke.length >= 2 && pathLength(stroke) > 0)
      ? normalizedReferenceStrokes
      : [];
  const referenceVariants = [
    referenceStrokes,
    ...(Array.isArray(reference?.variants)
      ? reference.variants
          .map((variant) => normalizeStrokes(variant?.strokes))
          .filter((variant) => variant.length === referenceStrokes.length)
      : []),
  ];

  return {
    reviewStroke({ acceptedStrokes, candidate, errorCounts = {} }) {
      const accepted = normalizeStrokes(acceptedStrokes);
      const candidateStroke = normalizeStrokes([candidate])[0] ?? [];
      if (referenceStrokes.length === 0) {
        return {
          status: "unscorable",
          accept: true,
          remove: false,
          confidence: 0,
          reason: null,
          expectedStrokeIndex: accepted.length,
          matchedStrokeIndex: null,
          hint: null,
        };
      }

      const expectedStrokeIndex = accepted.length;
      if (expectedStrokeIndex >= referenceStrokes.length) {
        return rejectedStrokeDecision({
          code: "stroke_extra",
          message: "这个字已经写完整了",
          confidence: 1,
          expectedStrokeIndex,
          matchedStrokeIndex: null,
          expected: referenceStrokes.at(-1),
          errorCounts,
          hintPolicy: config.hints,
        });
      }

      const eligibleVariants = referenceVariants.filter((variant) =>
        accepted.every(
          (stroke, index) =>
            strokeMatchScore(stroke, variant[index], stageSize) >=
            config.strokeMatch.priorStroke,
        ),
      );
      const activeVariants =
        eligibleVariants.length > 0 ? eligibleVariants : [referenceStrokes];
      const expectedMatches = activeVariants.map((variant) => ({
        expected: variant[expectedStrokeIndex],
        score: strokeMatchScore(
          candidateStroke,
          variant[expectedStrokeIndex],
          stageSize,
        ),
      }));
      const bestExpected = expectedMatches.reduce((best, match) =>
        match.score > best.score ? match : best,
      );
      const expected = bestExpected.expected;
      const expectedScore = bestExpected.score;
      let bestFuture = { index: null, score: 0 };
      for (const variant of activeVariants) {
        for (
          let index = expectedStrokeIndex + 1;
          index < variant.length;
          index++
        ) {
          const score = strokeMatchScore(
            candidateStroke,
            variant[index],
            stageSize,
          );
          if (score > bestFuture.score) bestFuture = { index, score };
        }
      }
      if (
        bestFuture.score >= config.strokeMatch.laterStroke &&
        bestFuture.score > expectedScore + config.strokeMatch.laterStrokeMargin
      ) {
        return rejectedStrokeDecision({
          code: "stroke_order_wrong",
          message: `先写第 ${expectedStrokeIndex + 1} 笔`,
          confidence: clamp(
            0.6 + (bestFuture.score - expectedScore) * 0.5,
            0,
            1,
          ),
          expectedStrokeIndex,
          matchedStrokeIndex: bestFuture.index,
          expected,
          errorCounts,
          hintPolicy: config.hints,
        });
      }

      const reverseScore = Math.max(
        ...expectedMatches.map(({ expected: option }) =>
          strokeMatchScore(candidateStroke, [...option].reverse(), stageSize),
        ),
      );
      if (
        reverseScore >= config.strokeMatch.reversed &&
        reverseScore > expectedScore + config.strokeMatch.reversedMargin
      ) {
        return rejectedStrokeDecision({
          code: "stroke_direction_reversed",
          message: `第 ${expectedStrokeIndex + 1} 笔方向反了`,
          confidence: clamp(0.65 + (reverseScore - expectedScore) * 0.45, 0, 1),
          expectedStrokeIndex,
          matchedStrokeIndex: expectedStrokeIndex,
          expected,
          errorCounts,
          hintPolicy: config.hints,
        });
      }

      return {
        status:
          expectedScore >= config.strokeMatch.correct ? "correct" : "uncertain",
        accept: true,
        remove: false,
        confidence: roundScore(expectedScore),
        reason:
          expectedScore >= config.strokeMatch.correct
            ? null
            : {
                code: "stroke_uncertain",
                message: `第 ${expectedStrokeIndex + 1} 笔先保留，写完再一起看`,
                priority: 5,
                severity: "info",
              },
        expectedStrokeIndex,
        matchedStrokeIndex: expectedStrokeIndex,
        hint: null,
      };
    },
    assess({ strokes, process = {} }) {
      const kidStrokes = normalizeStrokes(strokes);
      if (referenceStrokes.length === 0) return unscorableResult();
      if (kidStrokes.length !== referenceStrokes.length) {
        return incompleteResult(kidStrokes.length, referenceStrokes);
      }

      const scoringReference = referenceVariants.reduce(
        (best, variant) => {
          const score = average(
            kidStrokes.map((stroke, index) =>
              strokeMatchScore(stroke, variant[index], stageSize),
            ),
          );
          return score > best.score ? { strokes: variant, score } : best;
        },
        { strokes: referenceStrokes, score: -1 },
      ).strokes;
      const breakdown = scoreAttempt(
        kidStrokes,
        scoringReference,
        stageSize,
        config,
      );
      const score = Math.round(
        Object.entries(config.weights).reduce(
          (total, [key, weight]) => total + breakdown[key] * weight,
          0,
        ) * 100,
      );
      const reasons = [
        ...buildProcessReasons(process),
        ...buildReasons(
          breakdown,
          kidStrokes,
          scoringReference,
          stageSize,
          config,
        ),
      ].sort((a, b) => a.priority - b.priority);
      const band = capBand(scoreToBand(score, config.bands), process);
      const processErrors =
        Number(process.orderErrors ?? 0) + Number(process.directionErrors ?? 0);
      const independentRetry = process.independentRetry === true;
      const followupRetry = process.followupRetry === true;
      const requiresRewrite =
        processErrors >= 2 ||
        reasons.some((reason) => reason.severity === "rewrite");
      const requiresIndependentRetry =
        processErrors > 0 && !independentRetry && !followupRetry;
      const requiresRetry =
        requiresRewrite &&
        !requiresIndependentRetry &&
        !independentRetry &&
        !followupRetry;
      const retryFailed =
        (independentRetry && (processErrors > 0 || requiresRewrite)) ||
        (followupRetry && (processErrors > 0 || requiresRewrite));
      const nextAction = requiresIndependentRetry
        ? "independent_retry"
        : requiresRetry
          ? "rewrite"
          : retryFailed
            ? "review_later"
            : "continue";
      const reviewRecommended =
        (breakdown.structure >= config.review.structureMin &&
          breakdown.structure < config.review.structureMax) ||
        Object.values(config.bands).some(
          (threshold) =>
            Math.abs(score - threshold) <= config.review.bandWindow,
        );

      return {
        status: "scored",
        canSubmit: true,
        score,
        band,
        breakdown,
        primaryReason: reasons[0] ?? null,
        secondaryReason: reasons[1] ?? null,
        reasons,
        requiresRewrite,
        requiresIndependentRetry,
        requiresRetry,
        nextAction,
        reviewNeeded: nextAction === "review_later",
        retryOutcome:
          independentRetry || followupRetry
            ? retryFailed
              ? "failed"
              : "passed"
            : null,
        reviewRecommended,
        algorithmVersion: ALGORITHM_VERSION,
      };
    },
  };
}

function rejectedStrokeDecision({
  code,
  message,
  confidence,
  expectedStrokeIndex,
  matchedStrokeIndex,
  expected,
  errorCounts,
  hintPolicy,
}) {
  const priorErrors = Number(errorCounts?.[expectedStrokeIndex] ?? 0);
  const level = Math.min(priorErrors + 1, hintPolicy.maxLevel);
  return {
    status: "incorrect",
    accept: false,
    remove: true,
    confidence: roundScore(confidence),
    reason: { code, message, priority: 1, severity: "blocking" },
    expectedStrokeIndex,
    matchedStrokeIndex,
    hint: {
      level,
      points: expected,
      showStart: level >= hintPolicy.startDirectionAt,
      showDirection: level >= hintPolicy.startDirectionAt,
      animate: level >= hintPolicy.animateAt,
    },
  };
}

function strokeMatchScore(candidate, expected, stageSize) {
  if (!candidate?.length || !expected?.length) return 0;
  const actual = resample(candidate);
  const reference = resample(expected);
  const pathScore = clamp(
    1 - pairedDistance(actual, reference) / (stageSize * 0.15),
    0,
    1,
  );
  const startScore = clamp(
    1 -
      Math.hypot(actual[0].x - reference[0].x, actual[0].y - reference[0].y) /
        (stageSize * 0.2),
    0,
    1,
  );
  const endScore = clamp(
    1 -
      Math.hypot(
        actual.at(-1).x - reference.at(-1).x,
        actual.at(-1).y - reference.at(-1).y,
      ) /
        (stageSize * 0.2),
    0,
    1,
  );
  const directionScore = (directionCosine(candidate, expected) + 1) / 2;
  const lengthScore =
    1 - relativeError(pathLength(candidate), pathLength(expected));
  return clamp(
    pathScore * 0.35 +
      startScore * 0.2 +
      endScore * 0.2 +
      directionScore * 0.15 +
      lengthScore * 0.1,
    0,
    1,
  );
}

function mergePolicy(policy) {
  return {
    ...DEFAULT_HANDWRITING_POLICY,
    ...policy,
    weights: {
      ...DEFAULT_HANDWRITING_POLICY.weights,
      ...(policy.weights ?? {}),
    },
    strokeMatch: {
      ...DEFAULT_HANDWRITING_POLICY.strokeMatch,
      ...(policy.strokeMatch ?? {}),
    },
    bands: { ...DEFAULT_HANDWRITING_POLICY.bands, ...(policy.bands ?? {}) },
    reasonThresholds: {
      ...DEFAULT_HANDWRITING_POLICY.reasonThresholds,
      ...(policy.reasonThresholds ?? {}),
    },
    review: { ...DEFAULT_HANDWRITING_POLICY.review, ...(policy.review ?? {}) },
    hints: { ...DEFAULT_HANDWRITING_POLICY.hints, ...(policy.hints ?? {}) },
  };
}

function normalizeStrokes(strokes) {
  if (!Array.isArray(strokes)) return [];
  return strokes
    .map((stroke) => (Array.isArray(stroke) ? stroke : stroke?.points))
    .map((points) =>
      Array.isArray(points)
        ? points
            .map((point) => ({ x: Number(point?.x), y: Number(point?.y) }))
            .filter(
              (point) => Number.isFinite(point.x) && Number.isFinite(point.y),
            )
        : [],
    )
    .filter((points) => points.length > 0);
}

function scoreAttempt(kid, reference, stageSize, policy) {
  if (sameStrokes(kid, reference)) {
    return { structure: 1, placement: 1, strokeQuality: 1, shape: 1 };
  }
  return {
    structure: structureScore(kid, reference, stageSize),
    placement: placementScore(kid, reference, stageSize, policy),
    strokeQuality: strokeQualityScore(kid, reference, stageSize),
    shape: overallShapeScore(kid, reference, stageSize),
  };
}

function sameStrokes(a, b) {
  return (
    a.length === b.length &&
    a.every(
      (stroke, index) =>
        stroke.length === b[index].length &&
        stroke.every((point, pointIndex) => {
          const expected = b[index][pointIndex];
          return point.x === expected.x && point.y === expected.y;
        }),
    )
  );
}

function structureScore(kid, reference, stageSize) {
  const kidBounds = boundsOf(kid);
  const refBounds = boundsOf(reference);
  const extentError = average([
    extentErrorForAxis(kidBounds.width, refBounds.width, stageSize),
    extentErrorForAxis(kidBounds.height, refBounds.height, stageSize),
  ]);
  const centerErrors =
    kid.length === 1
      ? [0]
      : kid.map((stroke, index) => {
          const actual = normalizedCenter(stroke, kidBounds);
          const expected = normalizedCenter(reference[index], refBounds);
          return Math.hypot(actual.x - expected.x, actual.y - expected.y);
        });
  const centerError = average(centerErrors);
  return roundScore(clamp(1 - extentError * 0.7 - centerError * 1.4, 0, 1));
}

function extentErrorForAxis(actual, expected, stageSize) {
  const naturalPenJitter = stageSize * 0.02;
  if (actual <= naturalPenJitter && expected <= naturalPenJitter) return 0;
  return relativeError(actual, expected);
}

function placementScore(kid, reference, stageSize, policy) {
  const drift = placementDrift(kid, reference, stageSize).fraction;
  if (drift <= policy.placementNatural + 1e-9) return 1;
  if (drift <= policy.placementMinor) {
    return roundScore(
      1 -
        ((drift - policy.placementNatural) /
          (policy.placementMinor - policy.placementNatural)) *
          0.25,
    );
  }
  if (drift <= policy.placementMajor) {
    return roundScore(
      0.75 -
        ((drift - policy.placementMinor) /
          (policy.placementMajor - policy.placementMinor)) *
          0.45,
    );
  }
  return roundScore(clamp(0.3 - (drift - policy.placementMajor) * 2, 0, 0.3));
}

function strokeQualityScore(kid, reference, stageSize) {
  return roundScore(
    average(
      kid.map((stroke, index) =>
        singleStrokeQuality(stroke, reference[index], stageSize),
      ),
    ),
  );
}

function singleStrokeQuality(stroke, expected, stageSize) {
  const lengthScore =
    1 - relativeError(pathLength(stroke), pathLength(expected));
  const directionScore = (directionCosine(stroke, expected) + 1) / 2;
  const actualShape = translateToOrigin(resample(stroke));
  const expectedShape = translateToOrigin(resample(expected));
  const shapeError = pairedDistance(actualShape, expectedShape) / stageSize;
  const shapeScore = clamp(1 - shapeError / 0.08, 0, 1);
  return clamp(
    lengthScore * 0.4 + directionScore * 0.3 + shapeScore * 0.3,
    0,
    1,
  );
}

function overallShapeScore(kid, reference, stageSize) {
  const errors = kid.map(
    (stroke, index) =>
      pairedDistance(resample(stroke), resample(reference[index])) / stageSize,
  );
  const error = average(errors);
  const distanceScore =
    error <= 0.03 ? 1 : clamp(1 - (error - 0.03) / 0.17, 0, 1);
  const overlapScore = centerlineIoU(kid, reference, stageSize);
  return roundScore(distanceScore * 0.85 + overlapScore * 0.15);
}

function centerlineIoU(actual, expected, stageSize) {
  const actualCells = occupiedCells(actual, stageSize);
  const expectedCells = occupiedCells(expected, stageSize);
  if (actualCells.size === 0 || expectedCells.size === 0) return 0;
  let intersection = 0;
  for (const cell of actualCells) {
    if (expectedCells.has(cell)) intersection++;
  }
  const union = actualCells.size + expectedCells.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function occupiedCells(strokes, stageSize, gridSize = 60) {
  const cells = new Set();
  for (const point of strokes.flatMap((stroke) => resample(stroke, 48))) {
    const x = Math.floor((point.x / stageSize) * gridSize);
    const y = Math.floor((point.y / stageSize) * gridSize);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cellX = x + dx;
        const cellY = y + dy;
        if (cellX >= 0 && cellX < gridSize && cellY >= 0 && cellY < gridSize) {
          cells.add(`${cellX}:${cellY}`);
        }
      }
    }
  }
  return cells;
}

function buildReasons(breakdown, kid, reference, stageSize, policy) {
  const reasons = [];
  const drift = placementDrift(kid, reference, stageSize);
  if (drift.fraction > policy.placementNatural + 1e-9) {
    const horizontal = Math.abs(drift.dx) >= Math.abs(drift.dy);
    const code = horizontal
      ? drift.dx > 0
        ? "placement_right"
        : "placement_left"
      : drift.dy > 0
        ? "placement_down"
        : "placement_up";
    const message = horizontal
      ? drift.dx > 0
        ? "整体向左一点，先看准方格中心"
        : "整体向右一点，先看准方格中心"
      : drift.dy > 0
        ? "整体向上一点，注意方格中心"
        : "整体向下一点，注意方格中心";
    reasons.push({
      code,
      message,
      priority: 3,
      severity:
        drift.fraction > policy.placementMajor ? "rewrite" : "suggestion",
      overlay: { kind: "translation", dx: -drift.dx, dy: -drift.dy },
    });
  }
  if (breakdown.structure < policy.reasonThresholds.structure) {
    reasons.push({
      code: "structure_proportion",
      message: "先比较各部分的宽窄和高低",
      priority: 4,
      severity: "suggestion",
      overlay: {
        kind: "bounds",
        actual: boundsOf(kid),
        expected: boundsOf(reference),
      },
    });
  }
  if (breakdown.strokeQuality < policy.reasonThresholds.strokeQuality) {
    const strokeScores = kid.map((stroke, index) =>
      singleStrokeQuality(stroke, reference[index], stageSize),
    );
    const strokeIndex = strokeScores.reduce(
      (worst, score, index) => (score < strokeScores[worst] ? index : worst),
      0,
    );
    reasons.push({
      code: "stroke_geometry",
      message: "再看看每一笔的方向和长短",
      priority: 5,
      severity: "suggestion",
      overlay: { kind: "stroke", strokeIndex },
    });
  }
  if (breakdown.shape < policy.reasonThresholds.shape) {
    reasons.push({
      code: "shape_mismatch",
      message: "整体形状还可以再接近范字一些",
      priority: 6,
      severity: "suggestion",
      overlay: { kind: "character", expected: boundsOf(reference) },
    });
  }
  return reasons.sort((a, b) => a.priority - b.priority);
}

function buildProcessReasons(process) {
  const orderErrors = Number(process.orderErrors ?? 0);
  const directionErrors = Number(process.directionErrors ?? 0);
  if (orderErrors > 0) {
    const review = lastStrokeReview(process, "stroke_order_wrong");
    return [
      {
        code: "stroke_order_wrong",
        message: "笔顺改对了，再独立写一次记牢它",
        priority: 1,
        severity: orderErrors >= 2 ? "rewrite" : "blocking",
        overlay: {
          kind: "stroke-order",
          strokeIndex: review?.expectedStrokeIndex ?? null,
          points: review?.expectedPoints ?? [],
        },
      },
    ];
  }
  if (directionErrors > 0) {
    const review = lastStrokeReview(process, "stroke_direction_reversed");
    return [
      {
        code: "stroke_direction_reversed",
        message: "注意落笔方向，再独立写一次",
        priority: 1,
        severity: directionErrors >= 2 ? "rewrite" : "blocking",
        overlay: {
          kind: "stroke-direction",
          strokeIndex: review?.expectedStrokeIndex ?? null,
          points: review?.expectedPoints ?? [],
        },
      },
    ];
  }
  return [];
}

function lastStrokeReview(process, reasonCode) {
  return Array.isArray(process.strokeReviews)
    ? [...process.strokeReviews].reverse().find((review) => review?.reasonCode === reasonCode)
    : null;
}

function placementDrift(kid, reference, stageSize) {
  const displacements = [
    displacement(centerOf(kid), centerOf(reference)),
    ...kid.map((stroke, index) =>
      displacement(centerOf([stroke]), centerOf([reference[index]])),
    ),
  ];
  const worst = displacements.reduce((current, candidate) =>
    Math.max(Math.abs(candidate.dx), Math.abs(candidate.dy)) >
    Math.max(Math.abs(current.dx), Math.abs(current.dy))
      ? candidate
      : current,
  );
  return {
    ...worst,
    fraction: Math.max(Math.abs(worst.dx), Math.abs(worst.dy)) / stageSize,
  };
}

function displacement(actual, expected) {
  return { dx: actual.x - expected.x, dy: actual.y - expected.y };
}

function centerOf(strokes) {
  const points = strokes.flatMap((stroke) => resample(stroke));
  return {
    x: average(points.map((point) => point.x)),
    y: average(points.map((point) => point.y)),
  };
}

function boundsOf(strokes) {
  const points = strokes.flat();
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

function normalizedCenter(stroke, bounds) {
  const center = centerOf([stroke]);
  return {
    x: (center.x - bounds.minX) / Math.max(bounds.width, 1),
    y: (center.y - bounds.minY) / Math.max(bounds.height, 1),
  };
}

function pathLength(points) {
  let total = 0;
  for (let index = 1; index < points.length; index++) {
    total += Math.hypot(
      points[index].x - points[index - 1].x,
      points[index].y - points[index - 1].y,
    );
  }
  return total;
}

function resample(points, count = 24) {
  if (points.length === 1)
    return Array.from({ length: count }, () => ({ ...points[0] }));
  const total = pathLength(points);
  if (total === 0)
    return Array.from({ length: count }, () => ({ ...points[0] }));
  const out = [];
  let segment = 1;
  let travelled = 0;
  for (let sample = 0; sample < count; sample++) {
    const target = (sample / (count - 1)) * total;
    while (segment < points.length - 1) {
      const length = Math.hypot(
        points[segment].x - points[segment - 1].x,
        points[segment].y - points[segment - 1].y,
      );
      if (travelled + length >= target) break;
      travelled += length;
      segment++;
    }
    const start = points[segment - 1];
    const end = points[segment];
    const length = Math.hypot(end.x - start.x, end.y - start.y) || 1;
    const ratio = clamp((target - travelled) / length, 0, 1);
    out.push({
      x: start.x + (end.x - start.x) * ratio,
      y: start.y + (end.y - start.y) * ratio,
    });
  }
  return out;
}

function translateToOrigin(points) {
  const first = points[0];
  return points.map((point) => ({
    x: point.x - first.x,
    y: point.y - first.y,
  }));
}

function pairedDistance(a, b) {
  return average(
    a.map((point, index) =>
      Math.hypot(point.x - b[index].x, point.y - b[index].y),
    ),
  );
}

function directionCosine(a, b) {
  const av = { x: a.at(-1).x - a[0].x, y: a.at(-1).y - a[0].y };
  const bv = { x: b.at(-1).x - b[0].x, y: b.at(-1).y - b[0].y };
  const denominator = Math.hypot(av.x, av.y) * Math.hypot(bv.x, bv.y);
  return denominator === 0
    ? 0
    : clamp((av.x * bv.x + av.y * bv.y) / denominator, -1, 1);
}

function relativeError(actual, expected) {
  return clamp(
    Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-9),
    0,
    1,
  );
}

function average(values) {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundScore(value) {
  return Math.round(value * 1000) / 1000;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function scoreToBand(score, bands) {
  if (score >= bands.great) return "写得很好";
  if (score >= bands.standard) return "写得规范";
  if (score >= bands.basic) return "基本正确";
  return "需要再观察";
}

function capBand(band, process) {
  const orderErrors =
    Number(process.orderErrors ?? 0) + Number(process.directionErrors ?? 0);
  if (orderErrors >= 2) return lowerBand(band, "基本正确");
  if (orderErrors === 1) return lowerBand(band, "写得规范");
  return band;
}

function lowerBand(actual, cap) {
  const order = ["需要再观察", "基本正确", "写得规范", "写得很好"];
  return order[Math.min(order.indexOf(actual), order.indexOf(cap))];
}

function unscorableResult() {
  const reason = {
    code: "reference_unavailable",
    message: "这次暂时无法判断，不是你写错了",
    priority: 0,
    severity: "info",
  };
  return {
    status: "unscorable",
    canSubmit: true,
    score: null,
    band: "暂时无法判断",
    breakdown: null,
    primaryReason: reason,
    secondaryReason: null,
    reasons: [reason],
    requiresRewrite: false,
    reviewRecommended: false,
    nextAction: "continue",
    reviewNeeded: false,
    retryOutcome: null,
    algorithmVersion: ALGORITHM_VERSION,
  };
}

function incompleteResult(actual, referenceStrokes) {
  const expected = referenceStrokes.length;
  const missing = Math.max(0, expected - actual);
  const extra = Math.max(0, actual - expected);
  const reason = extra
    ? {
        code: "stroke_extra",
        message: "这个字已经写完整了",
        priority: 2,
        severity: "rewrite",
      }
    : {
        code: "stroke_missing",
        message: `还少 ${missing} 笔，先看看下一笔`,
        priority: 2,
        severity: "blocking",
      };
  return {
    status: "incomplete",
    canSubmit: false,
    score: null,
    band: "需要再观察",
    breakdown: null,
    primaryReason: reason,
    secondaryReason: null,
    reasons: [reason],
    nextStroke: missing > 0 ? referenceStrokes[actual] : null,
    requiresRewrite: extra > 0,
    reviewRecommended: false,
    nextAction: "continue",
    reviewNeeded: false,
    retryOutcome: null,
    algorithmVersion: ALGORITHM_VERSION,
  };
}

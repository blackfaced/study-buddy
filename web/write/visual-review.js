export function buildVisualReviewPayload({ assessment, imageBase64 }) {
  if (!assessment?.reviewRecommended) return null;
  const structure = assessment?.breakdown?.structure;
  return {
    imageBase64,
    localAssessment: {
      breakdown: {
        structure: typeof structure === "number" && Number.isFinite(structure) ? structure : null,
      },
    },
  };
}

export function childFacingVisualSuggestion(assessment, review) {
  if (assessment?.secondaryReason) return null;
  return typeof review?.suggestion === "string" && review.suggestion.length > 0
    ? review.suggestion
    : null;
}

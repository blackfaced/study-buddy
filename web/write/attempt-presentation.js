export function presentationForAttempt({ independentRetry = false } = {}) {
  if (independentRetry) {
    return {
      showCharacter: false,
      animateReference: false,
      initialPhase: "writing",
      status: "现在不看提示，独立写一次",
      allowReplay: false,
    };
  }
  return {
    showCharacter: true,
    animateReference: true,
    initialPhase: "animating",
    status: "看笔顺 ↓",
    allowReplay: true,
  };
}

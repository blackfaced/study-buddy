// web/write/dictation-mode.js
// =====================================================================
// Dictation mode (默写) session state machine — issue #196, part of
// the parent-operated loop #192. Lives inside the write app; this
// module is pure logic (no DOM, no TTS) so it runs under node --test.
//
// Flow per item (ordered words from the set, then the one sentence):
//
//   answering  → target hidden; TTS plays the item (client-side),
//                kid writes in the grid (or on paper) and may replay.
//                Replays are COUNTED but never an error (AC2).
//     ↓ submit
//   revealed   → target shown next to the kid's ink for self-check
//                (AC3). No auto-grading here — that's #197.
//     ↓ next
//   … → done   → all targets visible.
//
// Structural AC1 guarantee: `visibleText()` returns null until the
// item is revealed. The pre-submit audio channel (`speakText()`) is
// deliberately separate so a view can't accidentally render the
// answer early.
//
// AC4 (paper-and-pencil): submit with zero strokes is legal — the
// web app may act as a pure read-aloud player.
//
// AC5 (resume): snapshot() / restoreDictationSession() round-trip the
// serialisable state; the client persists snapshots to localStorage.
//
// Public API:
//   createDictationSession({ set })
//   restoreDictationSession(set, snapshot) → session | null
// =====================================================================

function buildItems(set) {
  const words = (set.words ?? []).map((text) => ({
    kind: "word",
    text,
    plannedPlays: set.wordPlays ?? 2,
    replays: 0,
    strokes: [],
    revealed: false,
  }));
  const sentence = {
    kind: "sentence",
    text: set.sentence,
    plannedPlays: set.sentencePlays ?? 3,
    replays: 0,
    strokes: [],
    revealed: false,
  };
  return [...words, sentence];
}

function makeSession(set, items, itemIndex, phase) {
  function current() {
    const it = items[itemIndex];
    return it ? { ...it, strokes: [...it.strokes] } : null;
  }

  return {
    get phase() { return phase; },
    get itemIndex() { return itemIndex; },
    get items() {
      return items.map((it) => ({ ...it, strokes: [...it.strokes] }));
    },
    get setId() { return set.id; },

    current,

    start() {
      if (phase !== "idle") return false;
      phase = items.length > 0 ? "answering" : "done";
      return true;
    },

    /** Text for the TTS channel — available while answering. */
    speakText() {
      const it = items[itemIndex];
      return it && phase !== "done" ? it.text : null;
    },

    /** Text for the DOM — null until the item is revealed (AC1). */
    visibleText() {
      const it = items[itemIndex];
      if (!it) return null;
      return it.revealed || phase === "done" ? it.text : null;
    },

    targetVisible() {
      return phase === "done" || !!items[itemIndex]?.revealed;
    },

    noteStroke(d) {
      if (phase !== "answering" || typeof d !== "string" || d === "") return false;
      items[itemIndex].strokes.push(d);
      return true;
    },

    undoStroke() {
      const it = items[itemIndex];
      if (phase !== "answering" || !it || it.strokes.length === 0) return false;
      it.strokes.pop();
      return true;
    },

    /** One extra listen. Counted, never an error (AC2). */
    replay() {
      if (phase !== "answering") return false;
      items[itemIndex].replays += 1;
      return true;
    },

    submit(strokes) {
      if (phase !== "answering") return null;
      const it = items[itemIndex];
      if (Array.isArray(strokes)) it.strokes = strokes.map(String);
      it.revealed = true;
      phase = "revealed";
      return {
        setId: set.id,
        itemIndex,
        kind: it.kind,
        replays: it.replays,
        strokes: [...it.strokes],
      };
    },

    next() {
      if (phase !== "revealed") return false;
      itemIndex += 1;
      phase = itemIndex >= items.length ? "done" : "answering";
      return true;
    },

    snapshot() {
      return {
        setId: set.id,
        itemIndex,
        phase,
        items: items.map((it) => ({
          replays: it.replays,
          strokes: [...it.strokes],
          revealed: it.revealed,
        })),
      };
    },
  };
}

export function createDictationSession({ set }) {
  return makeSession(set, buildItems(set), 0, "idle");
}

export function restoreDictationSession(set, snapshot) {
  if (!snapshot || snapshot.setId !== set.id) return null;
  const items = buildItems(set);
  if (snapshot.itemIndex < 0 || snapshot.itemIndex > items.length) return null;
  for (let i = 0; i < items.length; i += 1) {
    const saved = snapshot.items?.[i];
    if (!saved) continue;
    items[i].replays = saved.replays ?? 0;
    items[i].strokes = Array.isArray(saved.strokes) ? saved.strokes.map(String) : [];
    items[i].revealed = !!saved.revealed;
  }
  return makeSession(set, items, snapshot.itemIndex, snapshot.phase ?? "answering");
}

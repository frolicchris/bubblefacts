/* Screen reader helpers for the renderer; plain functions, so tests run them without a window */
(function () {
  "use strict";

  /** What to announce on a status light redraw: only a change into a warning or problem, never the same light again */
  function lightAnnouncement(prev, next, label) {
    if (next.kind !== "warn" && next.kind !== "bad") return "";
    if (prev && prev.kind === next.kind && prev.text === next.text) return "";
    return `${label}: ${next.text}`;
  }

  /** A fact's length counter announces going over the limit once, again only after dropping under and crossing again */
  function counterStep(wasOver, length, max, message) {
    const over = length > max;
    return { over, announce: over && !wasOver ? message : "" };
  }

  window.A11y = { lightAnnouncement, counterStep };
})();

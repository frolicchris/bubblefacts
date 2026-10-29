/* Small screen reader helpers for the renderer. Plain functions, so tests can run them without a window. */
(function () {
  "use strict";

  /**
   * What to announce when a status light is redrawn: only a change into a warning or a
   * problem, never the same light again on the next poll.
   */
  function lightAnnouncement(prev, next, label) {
    if (next.kind !== "warn" && next.kind !== "bad") return "";
    if (prev && prev.kind === next.kind && prev.text === next.text) return "";
    return `${label}: ${next.text}`;
  }

  /**
   * A fact's length counter announces once when the text goes over the limit, and again
   * only after it has dropped back under and crossed again.
   */
  function counterStep(wasOver, length, max, message) {
    const over = length > max;
    return { over, announce: over && !wasOver ? message : "" };
  }

  window.A11y = { lightAnnouncement, counterStep };
})();

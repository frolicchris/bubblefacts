/**
 * What the built-in AI reads besides the app's own prompt (issue #431). node-llama-cpp's chat templates for some
 * models add "Today Date: ..." to the system message unless told not to, so the same song, article and temperature 0
 * gave the AI a different text every day, and its captions could differ with it. The date adds nothing to restating
 * a sentence from a source, so it is left out: the same input gives the same captions on any day.
 */

/** Every node-llama-cpp chat template with a `todayDate` (3.22.3), by its name there; scripts/builtin-chat.test.mjs checks none is missed */
export const NO_TODAY_DATE = {
  "llama3.1": { todayDate: null },
  "llama3.2-lightweight": { todayDate: null },
  harmony: { todayDate: null },
  muse: { todayDate: null },
} as const;

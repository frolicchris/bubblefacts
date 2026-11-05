/**
 * Size limits shared by grounding, screening and the fact sources.
 */

export const MAX_CONTEXT_CHARS = 3000;
/** Shorter extracts are stubs; the entry's own data beats restating one. */
export const MIN_CONTEXT_CHARS = 600;
/** Longest fact that fits a bubble. */
export const MAX_FACT_CHARS = 160;

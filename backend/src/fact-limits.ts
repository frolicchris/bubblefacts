// Size limits shared by grounding, screening and the fact sources

export const MAX_CONTEXT_CHARS = 3000;  // reference given to the model
export const MIN_CONTEXT_CHARS = 600;   // shorter is a stub: the entry's own data beats it
export const MAX_FACT_CHARS = 160;      // fits a bubble

/**
 * Thinking models (issue #198). Qwen3 and Qwen3.5 take `enable_thinking` in their chat template;
 * Gemma 4 and others carry a think tag. Given the app's plain prompt and 512 tokens, such a model
 * spends every token thinking and returns no captions. So the app answers through the model's own
 * template with reasoning switched off, and gives thinking a zero token budget. Llama's template has
 * neither marker, so nothing changes for Standard or Larger AI.
 */

/** Whether a GGUF chat template has a thinking mode the app must switch off. */
export function templateThinks(template: unknown): boolean {
  return typeof template === "string" && /enable_thinking|<think>|<\|think\|>|thought/.test(template);
}

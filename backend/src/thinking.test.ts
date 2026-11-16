import { templateThinks } from "./thinking";

describe("templateThinks", () => {
  test("Qwen3 and Qwen3.5 templates take enable_thinking", () => {
    expect(templateThinks("{%- if enable_thinking is defined and enable_thinking is false %}<|im_start|>assistant\n<think>\n\n</think>{%- endif %}")).toBe(true);
  });
  test("a template with a think tag counts", () => {
    expect(templateThinks("<start_of_turn>model\n<think>")).toBe(true);
  });
  test("Llama 3 templates do not", () => {
    expect(templateThinks("{{- '<|start_header_id|>' + message['role'] + '<|end_header_id|>\\n\\n' + message['content'] | trim + '<|eot_id|>' }}")).toBe(false);
  });
  test("a missing template does not", () => {
    expect(templateThinks(undefined)).toBe(false);
    expect(templateThinks(null)).toBe(false);
  });
});

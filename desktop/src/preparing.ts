import { MODEL, ModelFile, modelPath } from "./model";
import type { Settings } from "./settings";

/**
 * "Prepare my songs" in the app (issues #293 to #297). The server prepares;
 * this file decides when, and is the only place its window messages live, so
 * main.ts only wires it in.
 */

/**
 * The server's settings for preparing: the Standard model writes the first pass when High
 * quality is chosen and Standard is downloaded too, being several times faster (issue #296).
 * Songs it wrote are written again by High quality once every song has its first pass.
 */
export function prepareEnv(s: Pick<Settings, "ai" | "aiQuality">, modelsDir: string, ready: (model: ModelFile) => boolean): Record<string, string> {
  if (s.ai !== "builtin" || s.aiQuality !== "high" || !ready(MODEL)) return {};
  return { PREPARE_MODEL_PATH: modelPath(modelsDir, MODEL) };
}

import path from "path";
import { MODEL, MODEL_HIGH } from "./model";
import { prepareEnv } from "./preparing";

describe("prepareEnv (issue #296)", () => {
  const all = () => true;
  it("has the Standard model prepare the first pass when High quality is chosen and Standard is downloaded", () => {
    expect(prepareEnv({ ai: "builtin", aiQuality: "high" }, "/models", all)).toEqual({ PREPARE_MODEL_PATH: path.join("/models", MODEL.file) });
  });

  it("adds nothing with Standard chosen, without the Standard model, or with another AI", () => {
    expect(prepareEnv({ ai: "builtin", aiQuality: "standard" }, "/models", all)).toEqual({});
    expect(prepareEnv({ ai: "builtin", aiQuality: "high" }, "/models", (m) => m === MODEL_HIGH)).toEqual({});
    expect(prepareEnv({ ai: "ollama", aiQuality: "high" }, "/models", all)).toEqual({});
  });
});

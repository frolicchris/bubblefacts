// Diagnostics for when the built-in AI won't load on a system: loads
// node-llama-cpp from an installed app with debug logging, processor-only,
// and reports how far it got. Run like smoke-packaged.mjs:
//   ELECTRON_RUN_AS_NODE=1 <app executable> scripts/smoke-llama-debug.mjs <resources dir> <model.gguf>
import path from "node:path";
import { pathToFileURL } from "node:url";

const [resources, modelPath] = process.argv.slice(2);
const entry = path.join(resources, "app.asar", "node_modules", "node-llama-cpp", "dist", "index.js");
const step = (s) => console.log(`[debug] ${s}`);

step(`importing ${entry}`);
const { getLlama, LlamaLogLevel } = await import(pathToFileURL(entry).href);
step("getLlama({ gpu: false })");
const llama = await getLlama({ gpu: false, build: "never", logLevel: LlamaLogLevel.debug });
step(`loaded llama: gpu=${llama.gpu} cpuMathCores=${llama.cpuMathCores ?? "?"}`);
step(`loading model ${modelPath}`);
const model = await llama.loadModel({ modelPath });
step("model loaded; creating a context");
const context = await model.createContext({ contextSize: 1024 });
step(`context ok (${context.contextSize} tokens). Everything loaded.`);
process.exit(0);

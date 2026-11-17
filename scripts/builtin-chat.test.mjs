import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveChatWrapper, specializedChatWrapperTypeNames } from "node-llama-cpp";

// The built-in AI must read the same text for the same song on any day (#431)
// node-llama-cpp is ESM, which jest doesn't load: so this runs on the compiled server, like dist-exports.test.mjs
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/backend");
const { NO_TODAY_DATE } = await import(pathToFileURL(path.join(dist, "builtin-chat.js")).href);

const chatHistory = [{ type: "system", text: "Write captions." }, { type: "user", text: "A song." }, { type: "model", response: [] }];
const read = (wrapper) => String(wrapper.generateContextState({ chatHistory }).contextText);

test("the built-in AI's chat template is not told today's date", () => {
  for (const type of ["llama3.1", "llama3.2-lightweight"]) {
    // The library's default does add it: without this the check below proves nothing
    assert.match(read(resolveChatWrapper({ type })), /Today Date:/, `${type}: the library no longer adds the date`);
    const text = read(resolveChatWrapper({ type, customWrapperSettings: NO_TODAY_DATE }));
    assert.doesNotMatch(text, /Today Date:/, type);
    assert.match(text, /Write captions\./, type);
  }
});

test("no chat template with a date setting is missed (run again after a node-llama-cpp update)", () => {
  for (const type of specializedChatWrapperTypeNames) {
    const wrapper = resolveChatWrapper({ type, customWrapperSettings: NO_TODAY_DATE });
    assert.equal(wrapper.todayDate ?? null, null, `${type} has a todayDate: add it to NO_TODAY_DATE in backend/src/builtin-chat.ts`);
  }
});

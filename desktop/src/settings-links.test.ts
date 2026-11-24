import fs from "fs";
import path from "path";
import { DEFAULTS, EDITABLE, ENUM_KEYS, Settings, sanitize, toServerEnv } from "./settings";

// A new setting touches about nine places. These three fail silently when one is missed (#226):
// a field the window sends but EDITABLE leaves out saves as "Saved" and is dropped, a choice the
// window offers but sanitize doesn't list resets to the default, and an environment name the server
// never reads does nothing. Each check reads the real window and server code, so a new setting is
// covered without adding to this file.

const html = fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8");
const settingKeys = new Set(Object.keys(DEFAULTS));

/** Every form control's name in the settings window, and the values its radios and options offer */
function windowFields(): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  const add = (name: string, value?: string) => {
    if (!fields.has(name)) fields.set(name, []);
    if (value !== undefined) fields.get(name)!.push(value);
  };
  for (const m of html.matchAll(/<(?:input|textarea)\b[^>]*\bname="([^"]+)"[^>]*>/g)) {
    const radio = /\btype="radio"/.test(m[0]) ? /\bvalue="([^"]*)"/.exec(m[0])?.[1] : undefined;
    add(m[1], radio);
  }
  for (const m of html.matchAll(/<select\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    add(m[1]);
    for (const o of m[2].matchAll(/<option\b[^>]*\bvalue="([^"]*)"/g)) fields.get(m[1])!.push(o[1]);
  }
  // The Style list has no name: a choice goes in the hidden bubbleStyle field; "file:" ones are Style files
  const style = /<select\b[^>]*\bid="s-style"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? "";
  for (const o of style.matchAll(/<option\b[^>]*\bvalue="([^"]*)"/g)) if (!o[1].startsWith("file:")) add("bubbleStyle", o[1]);
  return fields;
}

// The first-run setup's own controls, copied into settings by app.js rather than sent by name
const SETUP_ONLY = /^setup-/;

describe("what links a setting from the window to the server", () => {
  const fields = windowFields();

  it("finds the window's settings fields", () => {
    expect(fields.size).toBeGreaterThan(30);
  });

  it("lets the window save every setting it shows", () => {
    const named = [...fields.keys()].filter((n) => !SETUP_ONLY.test(n));
    // A name that is no setting is a typo in the window: its value would never be saved
    expect(named.filter((n) => !settingKeys.has(n))).toEqual([]);
    // A setting the window shows but EDITABLE leaves out is dropped on Save, which still says "Saved"
    expect(named.filter((n) => !EDITABLE.includes(n as keyof Settings))).toEqual([]);
  });

  it("keeps every choice the window offers, instead of resetting it to the default", () => {
    const reset: string[] = [];
    for (const key of ENUM_KEYS) {
      for (const value of fields.get(key) ?? []) {
        const kept = sanitize({ ...DEFAULTS, [key]: value } as Settings)[key];
        if (kept !== value) reset.push(`${key}: "${value}" became "${kept}"`);
      }
    }
    expect(reset).toEqual([]);
    // Every list the window offers is checked here, so a new one can't be left out by mistake
    const offered = [...fields.entries()].filter(([name, values]) => !SETUP_ONLY.test(name) && values.length > 1).map(([name]) => name);
    expect(offered.filter((name) => !(ENUM_KEYS as readonly string[]).includes(name))).toEqual([]);
  });

  it("only sends the server names it reads", () => {
    const paths = { modelsDir: "/models", logDir: "/logs", topicsDir: "/topics", clientId: "made-up-client", documentsDir: "/Documents" };
    const variants: Array<Partial<Settings>> = [];
    for (const songSource of ["streamersonglist", "streamelements", "nowplaying"] as const)
      for (const nowPlayingPreset of ["streamling", "nightbot", "whatsnowplaying", "none"] as const)
        for (const ai of ["builtin", "groq", "anthropic", "ollama"] as const)
          for (const tokenKind of ["oauth", "streamer"] as const)
            variants.push({ songSource, nowPlayingPreset, ai, tokenKind, seChannel: "madeupchannel", displayName: "Made Up", streamerId: 7 });
    variants.push({ shareFacts: true, shareUrl: "https://share.example.com/events", shareChannel: "madeupchannel", shareKey: "made-up-key-12345" });
    const sent = new Set<string>();
    for (const v of variants) for (const name of Object.keys(toServerEnv({ ...DEFAULTS, ...v } as Settings, paths))) sent.add(name);
    expect(sent.size).toBeGreaterThan(30);

    const backend = path.join(__dirname, "../../backend/src");
    const files = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [path.join(dir, e.name)] : []));
    const source = files(backend).map((f) => fs.readFileSync(f, "utf8")).join("\n");
    // Read as process.env.NAME or env.NAME (an env passed in), process.env["NAME"], or a name passed to config.ts's helpers
    const read = (name: string) => new RegExp(String.raw`(?:\benv\.${name}\b|["'\x60]${name}["'\x60])`).test(source);
    // Read by Node itself, not by BubbleFacts' code
    const NODE_OWN = new Set(["NODE_ENV"]);
    expect([...sent].filter((name) => !NODE_OWN.has(name) && !read(name)).sort()).toEqual([]);
  });
});

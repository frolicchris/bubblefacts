import fs from "fs";
import path from "path";

/** Every source file under a folder (tests and fixtures left out), by its path without ".ts". */
function sourceFiles(root: string, dir = root): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "fixtures" ? [] : sourceFiles(root, full);
    return /\.ts$/.test(entry.name) && !/\.(test|d)\.ts$/.test(entry.name) ? [path.relative(root, full).replace(/\.ts$/, "")] : [];
  });
}

/** Which of the folder's own files each file imports when it runs. `import type` is left out: it's gone once compiled. */
function importGraph(root: string): Map<string, string[]> {
  const files = sourceFiles(root);
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, `${file}.ts`), "utf8");
    const imports = [...source.matchAll(/^\s*(?:import|export)\s+(?!type\s)[^;]*?from\s+["'](\.[^"']+)["']/gms)]
      .map((m) => path.relative(root, path.resolve(root, path.dirname(file), m[1])))
      .filter((target) => files.includes(target));
    graph.set(file, [...new Set(imports)]);
  }
  return graph;
}

/** The groups of files that import each other in a circle, each group sorted. */
function cycles(graph: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const found: string[][] = [];
  const visit = (file: string) => {
    index.set(file, index.size);
    low.set(file, index.get(file)!);
    stack.push(file);
    for (const next of graph.get(file) ?? []) {
      if (!index.has(next)) visit(next);
      if (stack.includes(next)) low.set(file, Math.min(low.get(file)!, low.get(next)!));
    }
    if (low.get(file) !== index.get(file)) return;
    const group = stack.splice(stack.indexOf(file));
    if (group.length > 1) found.push(group.sort());
  };
  for (const file of graph.keys()) if (!index.has(file)) visit(file);
  return found;
}

const backend = importGraph(__dirname);
const desktop = importGraph(path.join(__dirname, "../../desktop/src"));

// A circle of imports means none of its files can be read, tested or moved on its own. The 2.2 split left 13 files in one.
it("has no files that import each other in a circle", () => {
  expect(backend.size).toBeGreaterThan(70);
  expect(desktop.size).toBeGreaterThan(15);
  expect(cycles(backend)).toEqual([]);
  expect(cycles(desktop)).toEqual([]);
});

// fact-verifier.ts gathers grounding/ and screening/ for the callers above them. A file they depend on that
// imported it back would close a circle, so those files import each name from the file that owns it.
it("keeps fact-verifier.ts for the callers above the fact pipeline", () => {
  const below = new Set<string>();
  const walk = (file: string) => {
    for (const next of backend.get(file) ?? []) {
      if (!below.has(next)) {
        below.add(next);
        walk(next);
      }
    }
  };
  walk("fact-verifier");
  expect(below.size).toBeGreaterThan(20);
  expect([...below].filter((file) => backend.get(file)!.includes("fact-verifier"))).toEqual([]);
});

/** Where a song comes from, and where its facts go: the server, the song services, the stream and other apps. */
const AROUND_THE_PIPELINE = [
  "server",
  "session",
  "song-source",
  "source-polling",
  "songlist-client",
  "streamelements-client",
  "centrifugo-client",
  "now-playing-file",
  "now-playing-folder",
  "obs-streaming",
  "share-song-facts",
  "shown-log",
  "aired-facts",
  "credit",
];

// Finding and checking a fact doesn't depend on which service named the song or where the bubble is shown,
// so a new song source or a new place for facts never touches grounding/ or screening/.
it("keeps grounding and screening apart from where songs come from and where facts go", () => {
  for (const name of AROUND_THE_PIPELINE) expect(backend.has(name)).toBe(true);
  const crossing = [...backend]
    .filter(([file]) => /^(grounding|screening)\//.test(file))
    .flatMap(([file, imports]) => imports.filter((target) => AROUND_THE_PIPELINE.includes(target)).map((target) => `${file} imports ${target}`));
  expect(crossing).toEqual([]);
});

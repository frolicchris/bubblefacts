import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import { writeFileAtomic } from "./atomic-write";

// The streamer's own facts as records in own-facts.json (#193), apart from settings.json and its secrets.
// The two boxes in Settings stay the way to edit them: lines in ("[Tag] text"), records stored, the same lines out,
// byte for byte, so the box and the server's pack are what they were before the store.
// Nothing reads the records yet but this file: features built on them (#177, expiry dates, duplicates) come after
// a usability check and a GUI check with real streamers.

export const OWN_FACTS_FILE = "own-facts.json";
/** A folder of backups, one per bring-in from settings.json: what the store held and the lines brought in */
export const OWN_FACTS_BACKUPS = "own-facts-backups";
/** Backups kept in it */
export const BACKUPS_KEPT = 10;
const FORMAT = "bubblefacts-own-facts";
/** own-facts.json format; raise when a later version must convert older files */
export const OWN_FACTS_VERSION = 1;

/** Characters a fact may have, as for song facts (SONG_FACT_LIMITS in song-facts.ts); a [Song] tag doesn't count */
export const FACT_LENGTH = 300;
/** Lines each box keeps */
export const MAX_LINES = 500;

export type Scope =
  | { type: "all" }
  | { type: "originals" }
  | { type: "tag"; tag: string }
  | { type: "song"; title: string; artist: string };

export interface FactRecord {
  /** Permanent and random, never built from the text: an edit keeps it */
  id: string;
  /** Normalized (normalizeText); what a later feature compares and sorts by */
  text: string;
  kind: "yours" | "joke";
  scope: Scope;
  /** The line exactly as typed, when it isn't the normalized one: the box and the stream show this */
  asTyped?: string;
  /** YYYY-MM-DD; stored, not acted on yet */
  expires?: string;
  created: string;
  modified: string;
  /** Fields a newer version added are kept as they are */
  [field: string]: unknown;
}

export interface OwnFactsFile {
  format: typeof FORMAT;
  version: number;
  facts: FactRecord[];
  [field: string]: unknown;
}

/** The two boxes in Settings, one line per fact */
export interface OwnFactLines {
  myFacts: string[];
  myOriginals: string[];
}
type List = keyof OwnFactLines;
const LISTS: List[] = ["myFacts", "myOriginals"];

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** "fct_" and 26 letters and digits from 16 random bytes */
export function newId(bytes: Buffer = randomBytes(16)): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return `fct_${out.slice(0, 26)}`;
}

/** A record's text: NFC, straight quotes, no control characters, one space between words, none at the ends */
export function normalizeText(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The test the server's topic.ts makes: a tag needs text after it
const TAGGED = /^\s*\[([^\]]+)\]\s*(.+)$/;

type Parsed = Pick<FactRecord, "text" | "scope" | "asTyped">;

/** One line of a box as a record's text and scope (and the line as typed, when that differs); null for a blank line */
export function parseLine(line: string, list: List): Parsed | null {
  const typed = line.trim();
  if (!typed) return null;
  const m = list === "myFacts" ? TAGGED.exec(typed) : null;
  const tag = m ? normalizeText(m[1]) : "";
  // The server reads tags in Your own facts only; a line in the other box shows as written
  const p: Parsed = m && tag
    ? { text: normalizeText(m[2]) || m[2], scope: { type: "tag", tag } }
    : { text: normalizeText(typed) || typed, scope: list === "myOriginals" ? { type: "originals" } : { type: "all" } };
  if (canonical(p) !== typed) p.asTyped = typed;
  return p;
}

const canonical = (f: Pick<FactRecord, "text" | "scope">) => (f.scope.type === "tag" ? `[${f.scope.tag}] ${f.text}` : f.text);

/** A record as its line in Settings: as typed, unless that no longer reads as this record */
export function toLine(f: Pick<FactRecord, "text" | "scope" | "asTyped">): string {
  if (typeof f.asTyped === "string") {
    const again = parseLine(f.asTyped, f.scope.type === "originals" ? "myOriginals" : "myFacts");
    if (again && canonical(again) === canonical(f)) return again.asTyped ?? canonical(again);
  }
  return canonical(f);
}

/** A box's lines as they're saved, the same rule as before the store: trimmed, blanks dropped, the first MAX_LINES */
export function normalizeLines(lines: readonly string[]): string[] {
  return lines.map((l) => l.trim()).filter(Boolean).slice(0, MAX_LINES);
}

/** The box a record's line goes in, or null for one the boxes can't show (a song's, or a newer version's) */
function listOf(f: unknown): List | null {
  if (!f || typeof f !== "object" || Array.isArray(f)) return null;
  const r = f as Record<string, unknown>;
  const scope = r.scope as Record<string, unknown> | null;
  if (typeof r.id !== "string" || !r.id || typeof r.text !== "string" || !r.text || !scope || typeof scope !== "object") return null;
  if (scope.type === "all") return "myFacts";
  if (scope.type === "tag") return typeof scope.tag === "string" && scope.tag ? "myFacts" : null;
  if (scope.type === "originals") return "myOriginals";
  return null;
}

/** The lines the two boxes show */
export function linesOf(store: OwnFactsFile): OwnFactLines {
  const out: OwnFactLines = { myFacts: [], myOriginals: [] };
  for (const f of store.facts) {
    const list = listOf(f);
    if (list) out[list].push(toLine(f));
  }
  return out;
}

export const emptyStore = (): OwnFactsFile => ({ format: FORMAT, version: OWN_FACTS_VERSION, facts: [] });

/**
 * The store with the boxes' lines in it. A line matching a stored one keeps its record whole (id, dates,
 * unknown fields); a changed line in the same place keeps its id, with a new `modified`; any other line
 * is a new record. Records the boxes can't show are kept, after theirs
 */
export function withLines(store: OwnFactsFile, lines: OwnFactLines, now = new Date().toISOString(), makeId: () => string = () => newId()): OwnFactsFile {
  const byList: Record<List, FactRecord[]> = { myFacts: [], myOriginals: [] };
  const others: FactRecord[] = [];
  for (const f of store.facts) {
    const list = listOf(f);
    if (list) byList[list].push(f);
    else others.push(f);
  }
  const facts: FactRecord[] = [];
  for (const list of LISTS) {
    const old = byList[list];
    const typed = normalizeLines(lines[list] ?? []);
    const used = new Set<number>();
    const kept: (FactRecord | null)[] = typed.map((line) => {
      const i = old.findIndex((f, j) => !used.has(j) && toLine(f) === line);
      if (i < 0) return null;
      used.add(i);
      return old[i];
    });
    for (const [i, line] of typed.entries()) {
      if (kept[i]) continue;
      const p = parseLine(line, list) as Parsed;
      if (i < old.length && !used.has(i)) {
        used.add(i);
        const { asTyped: _was, ...rest } = old[i];
        kept[i] = { ...rest, ...p, modified: now };
      } else {
        kept[i] = { id: makeId(), text: p.text, kind: "yours", scope: p.scope, ...(p.asTyped === undefined ? {} : { asTyped: p.asTyped }), created: now, modified: now };
      }
    }
    facts.push(...(kept as FactRecord[]));
  }
  return { ...store, format: FORMAT, version: Math.max(OWN_FACTS_VERSION, store.version), facts: [...facts, ...others] };
}

const READ_RETRIES = 3;    // retries when the file is locked (antivirus, OneDrive), not missing
const READ_RETRY_MS = 150; // ms between them

/** The saved store; null with none. A file that reads but isn't one is renamed to .unreadable; a locked one throws */
export function readStore(dir: string): OwnFactsFile | null {
  const file = path.join(dir, OWN_FACTS_FILE);
  let text: string;
  for (let attempt = 0; ; attempt++) {
    try {
      text = fs.readFileSync(file, "utf8");
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (attempt >= READ_RETRIES) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, READ_RETRY_MS);
    }
  }
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw.facts)) throw new Error("not a store");
    return { ...raw, format: FORMAT, version: typeof raw.version === "number" ? raw.version : OWN_FACTS_VERSION, facts: raw.facts as FactRecord[] };
  } catch {
    // Kept for a problem report; the backups also hold the lines
    console.error(`[App] ${OWN_FACTS_FILE} isn't a facts file; kept as ${OWN_FACTS_FILE}.unreadable.`);
    try {
      fs.renameSync(file, file + ".unreadable");
    } catch {
      // Starts without it
    }
    return null;
  }
}

/** The store couldn't be read at start (locked): nothing is saved over it this run */
let readFailed = false;

const stringList = (v: unknown): string[] | null => (Array.isArray(v) && v.every((l) => typeof l === "string") ? v : null);
const why = (err: unknown) => (err as NodeJS.ErrnoException).code ?? String(err);

/** A new backup in the backups folder, never over an earlier one; the oldest past BACKUPS_KEPT go */
function writeBackup(dir: string, backup: unknown, now: string): void {
  const folder = path.join(dir, OWN_FACTS_BACKUPS);
  fs.mkdirSync(folder, { recursive: true });
  const stamp = now.replace(/[:.]/g, "-");
  let name = `before-import ${stamp}.json`;
  for (let n = 2; fs.existsSync(path.join(folder, name)); n++) name = `before-import ${stamp} ${n}.json`;
  writeFileAtomic(path.join(folder, name), JSON.stringify(backup, null, 2));
  const all = fs.readdirSync(folder).filter((f) => f.startsWith("before-import ")).sort();
  for (const old of all.slice(0, -BACKUPS_KEPT)) fs.rmSync(path.join(folder, old), { force: true });
}

/**
 * The boxes' lines at start. Lines found in settings.json (saved before the store, or by an older version
 * after it) are brought in, with a new backup first: all of them when there's no store yet, else added after
 * the stored ones when they aren't there already, so nothing stored is ever replaced. Running it again changes
 * nothing. `moved`: the store now holds settings.json's lines, so settings.json can drop them; never after a
 * read or write that failed (a lock, a full disk), when settings.json keeps them for next time
 */
export function loadOwnFacts(dir: string, fromSettings: { myFacts?: unknown; myOriginals?: unknown }, now = new Date().toISOString()): { lines: OwnFactLines; moved: boolean } {
  const legacy = { myFacts: stringList(fromSettings.myFacts), myOriginals: stringList(fromSettings.myOriginals) };
  const settingsHadFacts = "myFacts" in fromSettings || "myOriginals" in fromSettings;
  const fallback = { myFacts: normalizeLines(legacy.myFacts ?? []), myOriginals: normalizeLines(legacy.myOriginals ?? []) };
  let store: OwnFactsFile | null;
  try {
    store = readStore(dir);
    readFailed = false;
  } catch (err) {
    // Locked, not broken: settings.json keeps its lines and nothing is written over either file
    readFailed = true;
    console.error(`[App] Couldn't read ${OWN_FACTS_FILE} (${why(err)}); using the facts in settings.json and saving them there this time.`);
    return { lines: fallback, moved: false };
  }
  const current = store ?? emptyStore();
  const lines = store ? linesOf(store) : fallback;
  if (store) {
    for (const list of LISTS) {
      const have = new Set(lines[list]);
      for (const line of fallback[list]) if (!have.has(line)) {
        have.add(line);
        lines[list].push(line);
      }
    }
  }
  const next = withLines(current, lines, now);
  if (JSON.stringify(next) !== JSON.stringify(current)) {
    try {
      // Backup first: what the store held and the lines brought in
      writeBackup(dir, { savedAt: now, fromSettings: { myFacts: legacy.myFacts ?? [], myOriginals: legacy.myOriginals ?? [] }, store }, now);
      writeFileAtomic(path.join(dir, OWN_FACTS_FILE), JSON.stringify(next, null, 2));
    } catch (err) {
      console.error(`[App] Couldn't write ${OWN_FACTS_FILE} (${why(err)}); the facts stay in settings.json for now.`);
      return { lines, moved: false };
    }
  }
  return { lines: linesOf(next), moved: settingsHadFacts };
}

/** Saves the boxes' lines, writing only when something changed; true when the store holds them now, false to keep them elsewhere */
export function saveOwnFacts(dir: string, lines: OwnFactLines, now = new Date().toISOString()): boolean {
  if (readFailed) return false;
  let current: OwnFactsFile | null;
  try {
    current = readStore(dir);
  } catch (err) {
    console.error(`[App] Couldn't read ${OWN_FACTS_FILE} (${why(err)}); facts saved in settings.json for now.`);
    return false;
  }
  if (!current && !lines.myFacts.length && !lines.myOriginals.length) return true;
  const next = withLines(current ?? emptyStore(), lines, now);
  if (current && JSON.stringify(next) === JSON.stringify(current)) return true;
  try {
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(path.join(dir, OWN_FACTS_FILE), JSON.stringify(next, null, 2));
    return true;
  } catch (err) {
    console.error(`[App] Couldn't write ${OWN_FACTS_FILE} (${why(err)}); facts saved in settings.json for now.`);
    return false;
  }
}

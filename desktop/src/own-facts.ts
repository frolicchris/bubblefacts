import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import { writeFileAtomic } from "./atomic-write";

// The streamer's own facts as records in own-facts.json (#193), apart from settings.json and its secrets.
// The two boxes in Settings stay the way to edit them: lines in ("[Tag] text"), records stored, the same lines out.
// Nothing reads the records yet but this file: features built on them (#177, expiry dates, duplicates) come after
// a usability check and a GUI check with real streamers.

export const OWN_FACTS_FILE = "own-facts.json";
/** What the store held, and the lines brought in, before an import changed it */
export const OWN_FACTS_BACKUP = "own-facts.before-import.json";
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
  text: string;
  kind: "yours" | "joke";
  scope: Scope;
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

/**
 * Text as stored: NFC, no control characters, one space between words, none at the ends. Curly quotes stay
 * as typed for now: straightening them would change what shows on stream (#193 asks for it; the maintainer decides)
 */
export function normalizeText(s: string): string {
  return s.normalize("NFC").replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();
}

// The same test the server's topic.ts makes: a tag needs text after it
const TAGGED = /^\[([^\]]+)\]\s*(.+)$/;

/** One line of a box as a record's text and scope; null for a blank line */
export function parseLine(line: string, list: List): { text: string; scope: Scope } | null {
  const clean = normalizeText(line);
  if (!clean) return null;
  // The server reads tags in Your own facts only; a line in the other box shows as written
  if (list === "myOriginals") return { text: clean, scope: { type: "originals" } };
  const m = TAGGED.exec(clean);
  const tag = m ? normalizeText(m[1]) : "";
  return m && tag ? { text: m[2], scope: { type: "tag", tag } } : { text: clean, scope: { type: "all" } };
}

/** A record as its line in Settings */
export function toLine(f: Pick<FactRecord, "text" | "scope">): string {
  return f.scope.type === "tag" ? `[${f.scope.tag}] ${f.text}` : f.text;
}

/** A box's lines as they're saved: normalized, blanks dropped, at most MAX_LINES; lines → records → lines gives these back */
export function normalizeLines(lines: readonly string[], list: List): string[] {
  return lines.map((l) => parseLine(l, list)).filter((p) => p !== null).slice(0, MAX_LINES).map(toLine);
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
    const parsed = (lines[list] ?? []).map((l) => parseLine(l, list)).filter((p) => p !== null).slice(0, MAX_LINES);
    const used = new Set<number>();
    const kept: (FactRecord | null)[] = parsed.map((p) => {
      const i = old.findIndex((f, j) => !used.has(j) && toLine(f) === toLine(p));
      if (i < 0) return null;
      used.add(i);
      return old[i];
    });
    for (const [i, p] of parsed.entries()) {
      if (kept[i]) continue;
      if (i < old.length && !used.has(i)) {
        used.add(i);
        kept[i] = { ...old[i], text: p.text, scope: p.scope, modified: now };
      } else {
        kept[i] = { id: makeId(), text: p.text, kind: "yours", scope: p.scope, created: now, modified: now };
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
    // Kept for a problem report; the automatic backups also hold the lines
    try {
      fs.renameSync(file, file + ".unreadable");
    } catch {
      // Starts empty
    }
    return null;
  }
}

/** The store couldn't be read (locked): nothing is saved over it this run */
let readFailed = false;

const stringList = (v: unknown): string[] | null => (Array.isArray(v) && v.every((l) => typeof l === "string") ? v : null);

/**
 * The boxes' lines at start. Lines found in settings.json (saved before the store, or by an older version
 * after it) are brought in once, with a backup first: all of them when there's no store yet, else each box
 * that has lines. `settingsHadFacts`: settings.json can drop them now. Running it again changes nothing
 */
export function loadOwnFacts(dir: string, fromSettings: { myFacts?: unknown; myOriginals?: unknown }, now = new Date().toISOString()): { lines: OwnFactLines; settingsHadFacts: boolean } {
  const legacy = { myFacts: stringList(fromSettings.myFacts), myOriginals: stringList(fromSettings.myOriginals) };
  const settingsHadFacts = "myFacts" in fromSettings || "myOriginals" in fromSettings;
  const fallback = { myFacts: normalizeLines(legacy.myFacts ?? [], "myFacts"), myOriginals: normalizeLines(legacy.myOriginals ?? [], "myOriginals") };
  let store: OwnFactsFile | null;
  try {
    store = readStore(dir);
    readFailed = false;
  } catch (err) {
    // Locked, not broken: settings.json keeps its lines and nothing is written over either file
    readFailed = true;
    console.error(`[App] Couldn't read ${OWN_FACTS_FILE} (${(err as NodeJS.ErrnoException).code ?? err}); not saving facts this time.`);
    return { lines: fallback, settingsHadFacts: false };
  }
  const current = store ?? emptyStore();
  const lines = linesOf(current);
  for (const list of LISTS) if (store === null || legacy[list]?.length) lines[list] = fallback[list];
  const next = withLines(current, lines, now);
  if (JSON.stringify(next) !== JSON.stringify(current)) {
    // Backup first: what the store held and the lines brought in
    const backup = { savedAt: now, fromSettings: { myFacts: legacy.myFacts ?? [], myOriginals: legacy.myOriginals ?? [] }, store };
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(path.join(dir, OWN_FACTS_BACKUP), JSON.stringify(backup, null, 2));
    writeFileAtomic(path.join(dir, OWN_FACTS_FILE), JSON.stringify(next, null, 2));
  }
  return { lines: linesOf(next), settingsHadFacts };
}

/** Saves the boxes' lines, writing only when something changed; never over a store that couldn't be read */
export function saveOwnFacts(dir: string, lines: OwnFactLines, now = new Date().toISOString()): void {
  if (readFailed) return;
  let current: OwnFactsFile | null;
  try {
    current = readStore(dir);
  } catch (err) {
    console.error(`[App] Couldn't read ${OWN_FACTS_FILE} (${(err as NodeJS.ErrnoException).code ?? err}); facts not saved.`);
    return;
  }
  if (!current && !lines.myFacts.length && !lines.myOriginals.length) return;
  const next = withLines(current ?? emptyStore(), lines, now);
  if (current && JSON.stringify(next) === JSON.stringify(current)) return;
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(path.join(dir, OWN_FACTS_FILE), JSON.stringify(next, null, 2));
}

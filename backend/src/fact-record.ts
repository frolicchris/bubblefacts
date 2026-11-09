import { createHash, randomBytes } from "crypto";

/**
 * The canonical record for a streamer's own facts (draft, issue #193; the
 * file format is documented in docs/schema/fact-record.schema.json).
 *
 * Nothing in the app reads this yet: it is the shape the streamer's own facts
 * are normalized to, with the checks every later feature needs.
 */

export const MAX_FACT_LENGTH = 300;

export type Scope =
  | { type: "all" }
  | { type: "originals" }
  | { type: "tag"; tag: string }
  | { type: "song"; title: string; artist?: string; songId?: number; videoId?: string; mbid?: string };

export interface FactRecord {
  id: string;
  text: string;
  kind: "yours" | "joke";
  scope: Scope;
  /** A date (YYYY-MM-DD): the fact is hidden from the day after. */
  expires?: string;
  created: string;
  modified: string;
  fingerprint?: string;
  /** Fields this version doesn't know are kept as they are: that is how later versions add fields without a migration. */
  [unknown: string]: unknown;
}

const ID_RE = /^[a-z]{3,4}_[0-9a-hjkmnp-tv-z]{26}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** A random, permanent id: never built from the text, so editing a fact doesn't change who it is. */
export function newId(prefix = "fct", bytes: Buffer = randomBytes(16)): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return `${prefix}_${out.slice(0, 26)}`;
}

/** Text as it is stored and shown: NFC, one space between words, straight quotes, no control characters. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Identity text: case, accents and punctuation don't count, the words do (like songIdentity in song-facts.ts). */
export const identityText = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** A short hash that finds likely duplicates fast. Always confirm by comparing the text. */
export const fingerprint = (text: string) => createHash("sha1").update(identityText(normalizeText(text))).digest("hex").slice(0, 16);

const scopeKey = (s: Scope) => JSON.stringify(s, Object.keys(s).sort());

/** `[Tag] text` is how a line says which songs it belongs to. */
export function parseLine(line: string): { tag?: string; text: string } {
  const m = normalizeText(line).match(/^\[([^\]]{1,80})\]\s*(.+)$/);
  return m ? { tag: normalizeText(m[1]), text: m[2] } : { text: normalizeText(line) };
}

export function toLine(f: Pick<FactRecord, "text" | "scope">): string {
  return f.scope.type === "tag" ? `[${f.scope.tag}] ${f.text}` : f.text;
}

export interface FromLinesOptions {
  now?: string;
  scope?: Extract<Scope, { type: "all" } | { type: "originals" }>;
  kind?: FactRecord["kind"];
  id?: () => string;
}

/** Today's lines to records. Blank lines go; lines over the limit are returned, not stored. */
export function fromLines(lines: string[], opts: FromLinesOptions = {}): { records: FactRecord[]; skipped: string[] } {
  const now = opts.now ?? new Date().toISOString();
  const seen = new Set<string>();
  const records: FactRecord[] = [];
  const skipped: string[] = [];
  for (const raw of lines) {
    const { tag, text } = parseLine(raw);
    if (!text) continue;
    if (text.length > MAX_FACT_LENGTH) {
      skipped.push(raw);
      continue;
    }
    const scope: Scope = tag ? { type: "tag", tag } : (opts.scope ?? { type: "all" });
    const fp = fingerprint(text);
    const k = `${scopeKey(scope)}\0${fp}`;
    if (seen.has(k)) continue;
    seen.add(k);
    records.push({ id: (opts.id ?? (() => newId()))(), text, kind: opts.kind ?? "yours", scope, created: now, modified: now, fingerprint: fp });
  }
  return { records, skipped };
}

export const toLines = (records: FactRecord[]) => records.map(toLine);

/** What is wrong with a record; an empty list means it can be stored. */
export function validateFact(f: unknown): string[] {
  const p: string[] = [];
  if (!f || typeof f !== "object" || Array.isArray(f)) return ["not an object"];
  const r = f as Record<string, unknown>;
  if (typeof r.id !== "string" || !ID_RE.test(r.id)) p.push("id is not a permanent id");
  if (typeof r.text !== "string" || !r.text) p.push("text is missing");
  else {
    if (r.text.length > MAX_FACT_LENGTH) p.push(`text is over ${MAX_FACT_LENGTH} characters`);
    if (r.text !== normalizeText(r.text)) p.push("text is not normalized");
  }
  if (!["yours", "joke"].includes(r.kind as string)) p.push("kind is not one of yours, joke");
  const s = r.scope as Record<string, unknown> | undefined;
  if (!s || typeof s !== "object") p.push("scope is missing");
  else if (s.type === "tag") {
    if (typeof s.tag !== "string" || !s.tag) p.push("tag scope needs a tag");
  } else if (s.type === "song") {
    if (typeof s.title !== "string" || !s.title) p.push("song scope needs a title");
  } else if (s.type !== "all" && s.type !== "originals") p.push("scope type is unknown");
  if (r.expires !== undefined && !(typeof r.expires === "string" && DATE_RE.test(r.expires))) p.push("expires is not a date");
  for (const k of ["created", "modified"] as const) if (typeof r[k] !== "string" || !TIME_RE.test(r[k] as string)) p.push(`${k} is not a date and time`);
  if (r.fingerprint !== undefined && !(typeof r.fingerprint === "string" && typeof r.text === "string" && r.fingerprint === fingerprint(r.text)))
    p.push("fingerprint does not match the text");
  return p;
}

/** Is it hidden on this day (YYYY-MM-DD)? A fact shows through its expiry date. */
export const isExpired = (f: Pick<FactRecord, "expires">, today: string) => !!f.expires && today > f.expires;

import { AsyncLocalStorage } from "async_hooks";

// What the same fact pipeline keeps apart from the stream while preparing a song ahead of time (#293)
// (ARCHITECTURE.md: Prepared songs)
export interface PrepContext {
  /** Facts written this run, in place of the stream's recent ones (repeats dropped when it plays) */
  recent: string[];
  /** What `record` would have counted, for the store, not the stream's counts and songs.log */
  outcome?: string;
  /** The article the facts came from, if any */
  article?: string;
  /** Model that wrote the captions; "" when no AI was asked */
  model?: string;
  /** Failed or throttled lookups for this song: its miss says nothing, so it isn't saved */
  trouble: number;
  /** Stopping the run aborts the AI's turn */
  signal: AbortSignal;
  /** Write with the stream's model, not the preparing one: the second pass (#296) */
  streamModel?: boolean;
  /** The AI's reply per reference, so an article songs share (an artist's, a game's) is retold once (#296) */
  answers: Map<string, { answer: string; track: string }>;
}

export const prepContext = new AsyncLocalStorage<PrepContext>();

/** The preparation this code runs in; undefined on the live path */
export const preparing = (): PrepContext | undefined => prepContext.getStore();

// Hosts whose failures make a lookup's miss meaningless
const LOOKUP_HOSTS = /(?:^|\.)(?:wikipedia\.org|wikidata\.org|musicbrainz\.org)$/;

let watching = false;

/** Counts failed and throttled lookups while preparing, so a false miss isn't saved; wraps `fetch` once, live calls pass through */
export function watchLookupTrouble(): void {
  if (watching) return;
  watching = true;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const ctx = prepContext.getStore();
    if (!ctx) return original(input, init);
    let host = "";
    try {
      host = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).hostname;
    } catch {
      // Not a web address the lookups use
    }
    const lookup = LOOKUP_HOSTS.test(host);
    try {
      const res = await original(input, init);
      if (lookup && (res.status === 429 || res.status >= 500)) {
        ctx.trouble++;
        // Which source said no, so a pause in the log traces to it
        console.log(`[Prepare] ${host} answered ${res.status}`);
      }
      return res;
    } catch (err) {
      if (lookup) {
        ctx.trouble++;
        console.log(`[Prepare] ${host} didn't answer: ${err instanceof Error ? err.name : "error"}`);
      }
      throw err;
    }
  }) as typeof fetch;
}

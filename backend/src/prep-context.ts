import { AsyncLocalStorage } from "async_hooks";

/**
 * What the fact pipeline needs to know while it prepares a song ahead of time
 * (issue #293) rather than writes for the song on stream. The pipeline is the
 * same one; only what belongs to the stream is kept apart:
 *
 * - `recent`: the facts already written this run, standing in for the
 *   stream's recent facts. Prepared facts must not be thinned by what one
 *   stream happened to show, and must not count as shown on the next one.
 *   Repeats are dropped when a prepared song plays (`preparedFacts`).
 * - `outcome`: what `record` would have counted, for the store, instead of the
 *   stream's counts and songs.log.
 * - `trouble`: requests that failed or were throttled while this song was
 *   prepared: a miss then says nothing, so the result isn't saved.
 * - `signal`: stopping the run aborts the AI's turn for it.
 * - `answers`: the AI's reply per reference, so an article several songs share
 *   (an artist's, a game's) is retold once for all of them (issue #296).
 */
export interface PrepContext {
  recent: string[];
  outcome?: string;
  /** The article the facts came from, when they came from one. */
  article?: string;
  /** The model that wrote the captions ("" when no AI was asked). */
  model?: string;
  trouble: number;
  signal: AbortSignal;
  answers: Map<string, { answer: string; track: string }>;
}

export const prepContext = new AsyncLocalStorage<PrepContext>();

/** The preparation this code runs in, or undefined on the live path. */
export const preparing = (): PrepContext | undefined => prepContext.getStore();

/** The hosts whose failures make a lookup's miss meaningless. */
const LOOKUP_HOSTS = /(?:^|\.)(?:wikipedia\.org|wikidata\.org|musicbrainz\.org)$/;

let watching = false;

/**
 * Count failed and throttled lookups made while a song is prepared. Every
 * source's own fetch helper treats a 429 or an outage as "nothing found, don't
 * cache"; for a song prepared once a month that would freeze "nothing found",
 * so the preparer needs to know. Wraps `fetch` once; outside a preparation it
 * passes everything straight through.
 */
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
      // Not a web address the lookups use.
    }
    const lookup = LOOKUP_HOSTS.test(host);
    try {
      const res = await original(input, init);
      if (lookup && (res.status === 429 || res.status >= 500)) ctx.trouble++;
      return res;
    } catch (err) {
      if (lookup) ctx.trouble++;
      throw err;
    }
  }) as typeof fetch;
}

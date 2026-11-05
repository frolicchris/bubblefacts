import { topic } from "./topic";

/**
 * The curated pool: the streamer's untagged custom facts take turns for a
 * song no source knows (issue #190).
 */

// --- Curated pool ------------------------------------------------------

/** A filler fact isn't shown again within this long: fewer bubbles instead (issue #190). */
export const CURATED_REST_MS = 60 * 60 * 1000;
/** When each filler fact was last handed out this session. In memory, so every stream starts fresh. */
const curatedShownAt = new Map<string, number>();

/**
 * `count` of the streamer's untagged custom facts (and the topic packs'), for a song no source
 * knows. They take turns: never shown first, in a random order, then the longest unused. A fact
 * handed out in the last CURATED_REST_MS isn't, so a small pool gives fewer bubbles rather than
 * the same fact on song after song (issue #190).
 */
export function curatedFacts(count: number, now = Date.now()): string[] {
  const pool = [...topic.curatedFacts];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picked = pool
    .map((text) => ({ text, at: curatedShownAt.get(text) ?? -Infinity }))
    .filter((f) => now - f.at >= CURATED_REST_MS)
    .sort((a, b) => a.at - b.at)
    .slice(0, Math.max(0, count))
    .map((f) => f.text);
  for (const text of picked) curatedShownAt.set(text, now);
  return picked;
}

/** Forget which filler facts were shown: the tests, between cases. */
export function resetCuratedTurns(): void {
  curatedShownAt.clear();
}

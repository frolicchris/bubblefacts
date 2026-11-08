import { topic } from "./topic";

// The curated pool: the streamer's untagged custom facts take turns for a song no source knows (#190)

// --- Curated pool ------------------------------------------------------

export const CURATED_REST_MS = 60 * 60 * 1000; // ms before a filler fact may show again; fewer bubbles instead
/** When each filler fact was last handed out; in memory, so every stream starts fresh */
const curatedShownAt = new Map<string, number>();

/** Up to `count` untagged custom facts, in turns: never shown first (random), then the longest unused; none rested under CURATED_REST_MS */
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

/** Forgets which filler facts were shown: tests, between cases */
export function resetCuratedTurns(): void {
  curatedShownAt.clear();
}

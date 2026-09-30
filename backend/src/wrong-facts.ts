import * as fs from "fs";
import * as path from "path";
import { config } from "./config";
import { SSLSong } from "./types";

/**
 * Articles the streamer marked wrong, per song. When a fact is wrong, the
 * usual cause is the wrong Wikipedia article ("The Midnight" grounded on a
 * racing game), so the article is never used for that song again. Kept in a
 * small JSON file so it survives restarts.
 */

type Store = Record<string, string[]>;

const file = () => path.join(config.dataDir, "wrong-facts.json");
let store: Store | null = null;

export function songKey(song: SSLSong): string {
  return `${song.artist ?? ""}:::${song.title}`.toLowerCase();
}

function load(): Store {
  if (store) return store;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file(), "utf8"));
    store = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Store) : {};
  } catch {
    store = {};
  }
  return store;
}

export function blockedArticles(song: SSLSong): Set<string> {
  return new Set(load()[songKey(song)] ?? []);
}

export function blockArticle(song: SSLSong, article: string): void {
  const s = load();
  const key = songKey(song);
  const list = s[key] ?? [];
  if (list.includes(article)) return;
  s[key] = [...list, article];
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(s, null, 2) + "\n");
  } catch (err) {
    // Still blocked for this session; only the restart memory is lost.
    console.warn(`[WrongFacts] Could not save ${file()}: ${err instanceof Error ? err.message : err}`);
  }
}

/** For tests. */
export function resetWrongFacts(): void {
  store = null;
}

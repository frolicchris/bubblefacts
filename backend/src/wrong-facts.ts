import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "./atomic-write";
import { config } from "./config";
import { withoutArtistNote } from "./text";
import { SSLSong } from "./types";

// Sources marked Wrong, per song, in wrong-facts.json: the usual cause is the wrong article
// ("The Midnight" grounded on a racing game), so it's never used for that song again (ARCHITECTURE.md: Wrong and Undo)

type Store = Record<string, string[]>;

const file = () => path.join(config.dataDir, "wrong-facts.json");
let store: Store | null = null;

/** One song for caches and Wrong marks: list song ID or video ID (renames stay one song), else artist and title without a note (#262) */
export function songKey(song: SSLSong): string {
  if (song.songId) return `ssl:${song.songId}`;
  if (song.videoId) return `yt:${song.videoId}`;
  return `${withoutArtistNote(song.artist ?? "")}:::${song.title}`.toLowerCase();
}

/** A key saved with a note ("some band (note):::song") as `songKey` writes it now; the file isn't rewritten, for older versions */
function currentKey(saved: string): string {
  const at = saved.indexOf(":::");
  return saved.startsWith("ssl:") || saved.startsWith("yt:") || at < 0 ? saved : `${withoutArtistNote(saved.slice(0, at))}:::${saved.slice(at + 3)}`;
}

/** Every saved key that means this song: its own, and any saved with a note */
const keysFor = (s: Store, key: string) => Object.keys(s).filter((k) => k === key || currentKey(k) === key);

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
  const s = load();
  return new Set(keysFor(s, songKey(song)).flatMap((k) => s[k] ?? []));
}

export function blockArticle(song: SSLSong, article: string): void {
  const s = load();
  const key = songKey(song);
  const list = s[key] ?? [];
  if (list.includes(article)) return;
  s[key] = [...list, article];
  save(s);
}

function save(s: Store): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    writeFileAtomic(file(), JSON.stringify(s, null, 2) + "\n");
  } catch (err) {
    // Still in effect for this session; only the restart memory is lost
    console.warn(`[WrongFacts] Could not save ${file()}: ${err instanceof Error ? err.message : err}`);
  }
}

export function unblockArticle(song: SSLSong, article: string): void {
  const s = load();
  const keys = keysFor(s, songKey(song)).filter((k) => s[k]?.includes(article));
  if (!keys.length) return;
  for (const key of keys) {
    s[key] = s[key].filter((a) => a !== article);
    if (!s[key].length) delete s[key];
  }
  save(s);
}

/** For tests */
export function resetWrongFacts(): void {
  store = null;
}

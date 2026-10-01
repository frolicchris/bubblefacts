import * as fs from "fs";
import * as path from "path";
import { config } from "./config";

/**
 * Topic packs (topics/<id>.json): hand-verified fallback facts for songs with
 * no article, plus lines about the streamer's own compositions. TOPIC names
 * one pack or a comma-separated list, which are merged. A pack in the
 * streamer's own folder (BUBBLEFACTS_TOPICS_DIR) wins over a built-in one.
 */
export interface TopicPack {
  id: string;
  name: string;
  description?: string;
  curatedFacts: string[];
  originalsFacts?: string[];
}

const TOPICS_DIR = path.resolve(__dirname, "../../topics");
/** Fewer than this and every unknown song shows the same bubbles. */
const MIN_CURATED = 5;

function readPack(id: string): TopicPack {
  const name = `${id.replace(/[^a-z0-9-]/gi, "")}.json`;
  const dirs = [config.topicsDir, TOPICS_DIR].filter(Boolean);
  const file = dirs.map((dir) => path.join(dir, name)).find((f) => fs.existsSync(f));
  if (!file) {
    const available = dirs.flatMap((dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []))
      .filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
    throw new Error(`Unknown topic "${id}". Available: ${[...new Set(available)].join(", ")}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as TopicPack;
}

/** A custom fact for one song, artist or game: "[Song of Storms] It plays in a windmill." */
export interface TaggedFact {
  tag: string;
  text: string;
}
const TAGGED = /^\s*\[([^\]]+)\]\s*(.+)$/;

export interface Topics {
  /** Facts that fit any song. */
  curatedFacts: string[];
  originalsFacts: string[];
  /** Facts that only go with the song, artist or game they name. Never shown for anything else. */
  taggedFacts: TaggedFact[];
}

export function loadTopics(list: string): Topics {
  const packs = list.split(",").map((s) => s.trim()).filter((s) => s && s !== "none").map(readPack);
  const all = [...new Set(packs.flatMap((p) => p.curatedFacts ?? []))];
  const taggedFacts = all.flatMap((line) => {
    const m = TAGGED.exec(line);
    return m ? [{ tag: m[1].trim(), text: m[2].trim() }] : [];
  });
  const curatedFacts = all.filter((line) => !TAGGED.test(line));
  const originalsFacts = [...new Set(packs.flatMap((p) => p.originalsFacts ?? []))];
  // None is fine: a song with no source then shows no custom facts (issue #18).
  if (curatedFacts.length && curatedFacts.length < MIN_CURATED) {
    console.warn(`[Topic] "${list}" has only ${curatedFacts.length} custom facts, so they'll repeat often`);
  }
  return { curatedFacts, originalsFacts, taggedFacts };
}

export const topic = loadTopics(config.topic);

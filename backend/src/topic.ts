import * as fs from "fs";
import * as path from "path";
import { config } from "./config";

/**
 * A topic pack (topics/<TOPIC>.json): hand-verified fallback facts for songs
 * with no article, plus lines about the streamer's own compositions.
 */
export interface TopicPack {
  id: string;
  name: string;
  description?: string;
  curatedFacts: string[];
  originalsFacts: string[];
}

const TOPICS_DIR = path.resolve(__dirname, "../../topics");
const MIN_CURATED = 5;

export function loadTopic(id: string): TopicPack {
  const file = path.join(TOPICS_DIR, `${id.replace(/[^a-z0-9-]/gi, "")}.json`);
  if (!fs.existsSync(file)) {
    const available = fs.readdirSync(TOPICS_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
    throw new Error(`Unknown TOPIC "${id}". Available: ${available.join(", ")}`);
  }
  const pack = JSON.parse(fs.readFileSync(file, "utf8")) as TopicPack;
  if ((pack.curatedFacts?.length ?? 0) < MIN_CURATED) {
    throw new Error(`Topic "${id}" needs at least ${MIN_CURATED} curatedFacts`);
  }
  pack.originalsFacts ??= [];
  return pack;
}

export const topic = loadTopic(config.topic ?? "video-game-music");

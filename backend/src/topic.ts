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

export function loadTopics(list: string): Required<Pick<TopicPack, "curatedFacts" | "originalsFacts">> {
  const packs = list.split(",").map((s) => s.trim()).filter(Boolean).map(readPack);
  const curatedFacts = [...new Set(packs.flatMap((p) => p.curatedFacts ?? []))];
  const originalsFacts = [...new Set(packs.flatMap((p) => p.originalsFacts ?? []))];
  if (curatedFacts.length < MIN_CURATED) {
    throw new Error(`TOPIC "${list}" has ${curatedFacts.length} curated facts; add packs to reach ${MIN_CURATED}`);
  }
  return { curatedFacts, originalsFacts };
}

export const topic = loadTopics(config.topic);

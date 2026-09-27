import * as fs from "fs";
import * as path from "path";

/**
 * A topic pack: the hand-written facts the overlay falls back to when no
 * reference article exists for a song, plus lines about the streamer's own
 * compositions. Packs live in topics/<id>.json and are selected with TOPIC.
 *
 * Everything else — grounding, screening, the prompt — is topic-neutral: the
 * reference article decides what kind of work a song is. Only the fallback
 * pool needs to know what a channel plays, because a Tetris fact under a
 * Chopin nocturne is a non-sequitur.
 */
export interface TopicPack {
  id: string;
  name: string;
  description?: string;
  curatedFacts: string[];
  originalsFacts: string[];
}

const TOPICS_DIR = path.resolve(__dirname, "../../topics");

export function loadTopic(id: string): TopicPack {
  const safe = id.replace(/[^a-z0-9-]/gi, "");
  const file = path.join(TOPICS_DIR, `${safe}.json`);
  if (!fs.existsSync(file)) {
    const available = fs
      .readdirSync(TOPICS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
    throw new Error(`Unknown TOPIC "${id}". Available: ${available.join(", ")}`);
  }
  const pack = JSON.parse(fs.readFileSync(file, "utf8")) as TopicPack;
  if (!Array.isArray(pack.curatedFacts) || pack.curatedFacts.length < 5) {
    throw new Error(`Topic "${id}" needs at least 5 curatedFacts (has ${pack.curatedFacts?.length ?? 0})`);
  }
  pack.originalsFacts = Array.isArray(pack.originalsFacts) ? pack.originalsFacts : [];
  return pack;
}

export const topic: TopicPack = loadTopic(process.env.TOPIC || "video-game-music");

// Whether each of the AI's captions shows: every drop between its answer and the ranking, in the stream's
// order, with the reason (issue #226). The stream, the self-test, the corpus and the Wrong replay call this one
import type { SSLSong } from "../types";
import { loadedCaption } from "../neutral-wording";
import { aboutAnotherWork, type RequestProfile, type WorkKind } from "../work-resolver";
import { artistNames, mentionsName, normalizeTitle, resolveGameAndTrack } from "../grounding/titles";
import { keepsAttribution } from "../grounding/sections";
import { articleText } from "../grounding/covers";
import { isPerformerArticle } from "../grounding/work-match";
import { explainMusicTerms, restatesRequest, tooSimilar } from "./similarity";
import { qualifierRepair, repairQualifier, repairScope, scopeRepair } from "./repair";
import { screenClaims } from "./screen";

/** A screened caption: as the AI wrote it (what the screens and the cited sentence go by), in the words shown, and the sentence it cites */
export type Caption = { text: string; plain: string; cited?: string };

/**
 * Where a caption was dropped: `answer` before `screenClaims` (checks on the AI's whole answer), `claims` by
 * `screenClaims`, `after` by the checks that need the article, the match or what the stream showed
 */
export type DropStep = "answer" | "claims" | "after";
export type DroppedCaption = { caption: string; reason: string; step: DropStep };

export type CaptionCheck = {
  /** The AI's answer, one caption a line, trimmed, no empty lines */
  lines: string[];
  /** The reference the captions were written from; "" for none */
  context: string;
  /** The song on stream: a caption that only repeats its title and artist is dropped */
  song: SSLSong;
  /** The reading of the song that found the article: its track and artist */
  read: SSLSong;
  /** The soundtrack's other parts, from the whole article (`otherParts`): a caption about one is dropped */
  otherParts: string[];
  /** The captions cite their sentence ("3 | ...") */
  cited: boolean;
  /** The prompt's worked examples (`RETELL_EXAMPLES`): a caption copying their wording is dropped */
  examples: string;
  /** Facts shown lately: a near-repeat is dropped */
  recent: readonly string[];
  /** A shared answer's: the track of the song it was first written for */
  writtenFor?: string;
  /** The scored match, when it decides (MATCH=scored): a caption opening on a sister work is dropped */
  scored?: { request: RequestProfile; target: { page: string; kind: WorkKind } };
  /** Where the `[Screen]` lines go, each with the step that wrote it; none when left out */
  log?: (line: string, step: DropStep) => void;
};

export type ScreenedCaptions = {
  /** In the AI's order, repaired */
  kept: Caption[];
  /** In the order they were dropped */
  dropped: DroppedCaption[];
  /** The sentence each caption that passed `screenClaims` cites, when `cited` */
  sources?: Map<string, string>;
};

/** The reason for a caption that only repeats the title and artist; never logged, and it still counts as said */
export const RESTATES_REQUEST = "only repeats the title and artist";
const ALREADY_SHOWN = "already shown for an earlier song";

// Three of these in a row prove nothing
const COMMON_WORDS = new Set("the of a an s are is was were to in on and it its that by for with as about lyrics album song band said wrote".split(" "));
const words = (text: string) => text.toLowerCase().replace(/(\d),(\d)/g, "$1$2").match(/[a-z0-9]+/g) ?? [];
const threeWords = (list: string[]) => list.slice(0, -2).map((w, i) => `${w} ${list[i + 1]} ${list[i + 2]}`);
// Every three-word run in the examples, not all common words
const exampleWording = (examples: string) =>
  new Set(
    examples
      .split("\n")
      .filter((l) => /^(Text|Wrong|Right): /.test(l))
      .flatMap((l) => threeWords(words(l.replace(/^\w+: /, ""))))
      .filter((g) => g.split(" ").some((w) => !COMMON_WORDS.has(w)))
  );
const copies = (caption: string, context: string, wording: Set<string>) => {
  const source = ` ${words(context).join(" ")} `;
  return threeWords(words(caption)).some((g) => wording.has(g) && !source.includes(` ${g} `));
};

/** Three words in a row from an example that the reference lacks ("sound like a storm"); no other screen catches it */
export function copiesExample(caption: string, context: string, examples: string): boolean {
  return copies(caption, context, exampleWording(examples));
}

/** Whether the article is the song's own, not its game's or artist's */
export function aboutTheSong(song: SSLSong, context: string): boolean {
  const { game, track } = resolveGameAndTrack(song);
  if (!track || track === game) return true;
  return mentionsName(normalizeTitle(context.split("\n")[0]), [normalizeTitle(track)]);
}

/** Every caption of an answer, kept or dropped with the reason, as the stream decides it */
export function screenCaptions(check: CaptionCheck): ScreenedCaptions {
  const { context, read, song } = check;
  const log = check.log ?? (() => undefined);
  const dropped: DroppedCaption[] = [];
  const drop = (caption: string, reason: string, step: DropStep) => dropped.push({ caption, reason, step });
  const page = context.split("\n")[0];
  const { track } = resolveGameAndTrack(read);

  // Shared answer: a line naming its first song's track is about that one
  const otherTrack = check.writtenFor !== undefined && normalizeTitle(check.writtenFor) !== normalizeTitle(track) ? normalizeTitle(check.writtenFor) : "";
  const wording = exampleWording(check.examples);
  const lines = check.lines.filter((l) => {
    if (otherTrack && mentionsName(normalizeTitle(l), [otherTrack])) {
      log("[Screen] DROP (names the song it was first written for)", "answer");
      drop(l, "names the song it was first written for", "answer");
      return false;
    }
    if (!context || !copies(l, context, wording)) return true;
    log("[Screen] DROP (copies an example)", "answer");
    drop(l, "copies an example", "answer");
    return false;
  });

  const { kept, rejected, sources } = screenClaims(lines, context, { otherParts: check.otherParts, track: aboutTheSong(read, context) ? undefined : track, cited: check.cited, artists: artistNames(read.artist ?? "") });
  // Reason only, never the words: logs mustn't spread what was held back (#242, #262)
  for (const r of rejected) {
    log(`[Screen] DROP (${r.reason})`, "claims");
    drop(r.text, r.reason, "claims");
  }
  // A "someone said" caption must keep who said it
  const attributed = kept.filter((f) => {
    if (context && !keepsAttribution(f, context)) {
      log("[Screen] DROP (drops who said it)", "after");
      drop(f, "drops who said it", "after");
      return false;
    }
    if (loadedCaption(f, [read.title, read.artist ?? ""], isPerformerArticle(page, articleText(page) || context))) {
      log("[Screen] DROP (loaded wording)", "after");
      drop(f, "loaded wording", "after");
      return false;
    }
    // Opens on a sister work ("Some Game II sold")
    if (check.scored && aboutAnotherWork(f, check.scored.request, check.scored.target)) {
      log("[Screen] DROP (about another work)", "after");
      drop(f, "about another work", "after");
      return false;
    }
    return true;
  });
  const unseen = attributed.filter((f) => {
    if (!check.recent.some((r) => tooSimilar(r, f))) return true;
    drop(f, ALREADY_SHOWN, "after");
    return false;
  });
  if (unseen.length < attributed.length) log(`[Screen] DROP ${attributed.length - unseen.length} ${ALREADY_SHOWN}`, "after");
  // Restore a dropped limit ("in Japan", "usually"); drop the caption if it has no clear place
  const fresh = unseen.flatMap((f): Caption[] => {
    const scoped = context && scopeRepair.on ? repairScope(f, context) : f;
    const fixed = context && qualifierRepair.on ? repairQualifier(scoped, context) : { text: scoped };
    if ("drop" in fixed) {
      log(`[Screen] DROP (${fixed.drop})`, "after");
      drop(f, fixed.drop, "after");
      return [];
    }
    if (fixed.text !== f) log(`[Screen] SCOPE: ${f.slice(0, 70)} -> ${fixed.text.slice(0, 110)}`, "after");
    // Fixed plain words for music terms
    return [{ text: f, plain: explainMusicTerms(fixed.text), cited: sources?.get(f) }];
  });
  // A spare replaces a line that only repeats title and artist
  const usable = fresh.filter((c) => {
    if (!restatesRequest(c.plain, song)) return true;
    drop(c.text, RESTATES_REQUEST, "after");
    return false;
  });
  return { kept: usable, dropped, ...(sources ? { sources } : {}) };
}

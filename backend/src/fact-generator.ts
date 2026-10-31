import * as fs from "fs";
import * as path from "path";
import { config } from "./config";
import { Fact, SSLQueueItem, SSLSong } from "./types";
import { articleMisfit, articleText, artistNames, curatedFacts, dropVersionTags, editionNotInTitle, explainMusicTerms, fetchGrounding, isCoverOf, isPerformerArticle, isPlaceholderRequest, keepsAttribution, qualifierRepair, repairQualifier, mentionsName, normalizeTitle, numberedReference, otherParts, repairScope, resolveGameAndTrack, restatesRequest, scopeRepair, screenClaims, summaryGate, support, supportingSentence, tooSimilar, workMatchConfidence } from "./fact-verifier";
import { Candidate, MAX_BUBBLES, isLeadSentence, rankFacts } from "./fact-ranking";
import { hasNoArtist, withoutArtistNote, withoutRequestCredit } from "./text";
import { buildStatFacts, isOriginal, isOwnOriginal } from "./stat-facts";
import { parseVideoTitle } from "./youtube-title";
import { readings } from "./list-profile";
import { topic } from "./topic";
import { artistByTitle, cachedArtistByTitle, musicbrainzFacts, statedYear, statesAlbum, withoutYear } from "./musicbrainz";
import { standardBreach } from "./content-standard";
import { articleItem, artistFacts, songItemFacts, wikidataFacts } from "./wikidata";
import { alreadySaid, BoxFact, boxMisfit, infoboxFacts, valuesIn } from "./infobox";
import { factsOff, findSongFacts, hasOwnFacts, songFactLines, songIdentity } from "./song-facts";
import { blockArticle, blockedArticles, songKey, unblockArticle } from "./wrong-facts";
import { logWrong } from "./wrong-log";

/**
 * Turns a song into timed fact bubbles.
 *
 *   live learn  -> no facts (the overlay shows a banner)
 *   original    -> facts from the queue entry, no lookup
 *   article     -> model restates it, screening filters the result
 *   no article  -> entry facts + topic packs, no model call
 *   failure     -> entry facts + topic packs
 */

/** Ask for a few spares; screening drops some. */
const OVERGENERATE = 3;
const MAX_TOKENS = 512;
/** Hosted reasoning models, such as Groq's free gpt-oss, spend part of their budget thinking. */
const HOSTED_MAX_TOKENS = 2048;

/**
 * Bubble slots as CSS percentages of a 1920x1080 overlay. Laid out to avoid a
 * song-queue panel top-left, a camera top-right, goal widgets bottom-right and
 * the song banner bottom-center. `left` is the bubble's left edge; keep it
 * under ~66% so a 560px bubble stays on screen. Edit for your own scene.
 */
const POSITIONS = [
  { top: "8%", left: "33%" },
  { top: "57%", left: "9%" },
  { top: "26%", left: "33%" },
  { top: "57%", left: "40%" },
  { top: "42%", left: "33%" },
  { top: "70%", left: "9%" },
  { top: "16%", left: "34%" },
  { top: "70%", left: "40%" },
];

const spots = (list: Array<[number, number]>) => list.map(([top, left]): Fact["position"] => ({ top: `${top}%`, left: `${left}%` }));
/** Measured up from the bottom edge, so a bubble of any length sits low and never runs off the screen. */
const lowSpots = (list: Array<[number, number]>) => list.map(([bottom, left]): Fact["position"] => ({ bottom: `${bottom}%`, left: `${left}%` }));

/**
 * Top of the Now Playing bubble, from obs-overlay.css: `bottom: 60px`, plus two
 * lines of 1.944vh text at line-height 1.35 and its padding and border, plus a gap.
 */
const NOW_PLAYING_CLEARANCE = "calc(64px + 9.5vh * var(--bf-scale, 1))";

/**
 * BUBBLE_AREA: the part of the screen bubbles keep to, for streamers whose
 * layout has a camera, keyboard or chat where the default spots fall.
 * Same limits as above: `left` at most 66%, and clear of the banner at the bottom.
 */
const AREAS: Record<string, Array<Fact["position"]>> = {
  anywhere: POSITIONS,
  top: spots([[6, 6], [6, 37], [6, 66], [20, 20], [20, 52], [20, 6], [20, 66], [6, 22]]),
  // The middle of the lowest row is the Now Playing bubble's, so the first bubbles of a song keep to the sides.
  bottom: lowSpots([[5, 4], [5, 66], [20, 35], [20, 4], [20, 66], [5, 35], [12, 20], [12, 50]]),
  left: spots([[8, 3], [40, 3], [24, 3], [56, 3], [70, 3], [16, 3], [48, 3], [64, 3]]),
  right: spots([[8, 66], [40, 66], [24, 66], [56, 66], [70, 66], [16, 66], [48, 66], [64, 66]]),
  // One fixed spot each, for streamers who want bubbles in the same place every time. A new
  // bubble there replaces the last (the overlay hides the old one). Right spots are measured
  // from the right edge, and center ones have no left or right, so any bubble length stays put.
  "top-left": [{ top: "6%", left: "3%" }],
  "top-center": [{ top: "6%" }],
  "top-right": [{ top: "6%", right: "3%" }],
  "bottom-left": [{ bottom: "5%", left: "3%" }],
  // At the bottom edge like the other bottom spots; just above the Now Playing bubble while it shows
  // (positionsFor).
  "bottom-center": [{ bottom: "5%" }],
  "bottom-right": [{ bottom: "5%", right: "3%" }],
};

/**
 * The spots for the chosen area, in the order bubbles use them. `banner`: the Now Playing (or
 * LIVE LEARN) bubble shows at the bottom center, so a bubble there waits just above it (60px up,
 * and up to two lines of its text at any bubble size). With Now Playing off it's the true bottom center.
 */
export const positionsFor = (area: string = config.bubbleArea, banner: boolean = config.nowPlaying): Array<Fact["position"]> =>
  area === "bottom-center" && banner ? [{ bottom: NOW_PLAYING_CLEARANCE }] : AREAS[area] ?? POSITIONS;
/**
 * The vertical overlay (BubbleFacts Vertical.html), 1080x1920, for TikTok, YouTube Shorts and
 * Instagram Live. Phone apps cover parts of the picture with their own buttons and live chat,
 * so every spot keeps to the area all three leave clear (VERTICAL_SAFE, mirrored in
 * obs-overlay.css): below their top bar, above their chat, and left of the buttons on the right.
 * Spots have no left or right: the overlay centers each bubble between the safe side margins.
 */
export const VERTICAL_SAFE = { top: 14, bottom: 38, left: 6, right: 12 } as const;

/**
 * Top of the vertical Now Playing bubble, from obs-overlay.css: it sits on the chat line
 * (39% up), and is at most three lines of 3.2vw text at line-height 1.35 with its padding, plus a gap.
 */
const VERTICAL_NOW_PLAYING_CLEARANCE = "calc(39% + 20vw * var(--bf-vertical-scale, 1))";

/**
 * VERTICAL_AREA. One spot each: the area clear of the apps' own buttons and chat is about
 * 900 pixels tall, and a long fact at a bigger size fills a third of it, so a new bubble
 * replaces the last there (as with the landscape fixed spots). With the default timing only
 * one bubble is up at a time anyway.
 */
const VERTICAL_AREAS: Record<string, Array<Fact["position"]>> = {
  // Just below the apps' top bar, growing down.
  top: [{ top: "15%" }],
  // Sits on the chat line and grows upward, for streamers whose face is in the upper part.
  "above-chat": [{ bottom: "39%" }],
};

/**
 * The vertical overlay's spots for the chosen area. Its Now Playing bubble sits on the chat line,
 * so "above-chat" waits just above it while it shows, like bottom-center in the landscape overlay.
 */
export const verticalPositionsFor = (area: string = config.verticalArea, banner: boolean = config.nowPlaying): Array<Fact["position"]> =>
  area === "above-chat" && banner ? [{ bottom: VERTICAL_NOW_PLAYING_CLEARANCE }] : VERTICAL_AREAS[area] ?? VERTICAL_AREAS.top;

/** Whether a song starts with its banner: LIVE LEARN for a live learn, NOW PLAYING otherwise. Each can be turned off. */
export const showsBanner = (song: SSLSong) => (song.liveLearn ? config.liveLearnBanner : config.nowPlaying);
/** The spots for a song's bubbles, clear of its banner while it shows. */
export const positionsForSong = (song: SSLSong) => positionsFor(config.bubbleArea, showsBanner(song));
/** Both overlays' spots for a song's bubble number `i`: the landscape one and the vertical one. */
export const spotsForSong = (song: SSLSong) => {
  const landscape = positionsForSong(song);
  const vertical = verticalPositionsFor(config.verticalArea, showsBanner(song));
  return (i: number): Pick<Fact, "position" | "vertical"> => ({ position: landscape[i % landscape.length], vertical: vertical[i % vertical.length] });
};

export type Outcome = "grounded" | "wikidata" | "musicbrainz" | "songFacts" | "original" | "liveLearn" | "noReference" | "nothingSurvived" | "generationFailed" | "factsOff";

/** Per-session counts, reported on /health. */
export const factStats = {
  grounded: 0,
  wikidata: 0,
  musicbrainz: 0,
  songFacts: 0,
  original: 0,
  liveLearn: 0,
  noReference: 0,
  generationFailed: 0,
  nothingSurvived: 0,
  factsOff: 0,
  cacheHits: 0,
  lastDurationMs: 0,
  lastEndpoint: "",
  lastOutcome: "",
};

/** Songs with no usable facts are retried after this long; others are kept. */
const RETRY_MS = 10 * 60 * 1000;
const factCache = new Map<string, { facts: Fact[]; expires: number }>();
/** Stands for Wikidata and MusicBrainz in the blocklist, alongside Wikipedia article titles. */
export const STRUCTURED = "Wikidata and MusicBrainz";
/** The Wikidata or MusicBrainz sentences each song was given, to tell which source a wrong fact came from. */
const structuredShown = new Map<string, Set<string>>();
/** Which database each structured sentence came from, for the dashboard. */
const structuredLabel = new Map<string, string>();
/** The Wikipedia article each cached song's facts came from, for "Wrong". */
const sources = new Map<string, string>();
/**
 * Facts already written for earlier songs this session. Songs by the same
 * artist often share the artist's article, and the same facts twice in a row
 * look broken (issue #19).
 */
const RECENT_KEPT = 80;
const recentFacts: string[] = [];
/**
 * When each fact tagged for an artist or game was last picked. One game can
 * cover hundreds of songs on a list, so its facts take turns instead of
 * opening every one of those songs the same way.
 */
const poolTurns = new Map<string, number>();
let poolTurn = 0;
const inFlight = new Map<string, Promise<Fact[]>>();
/** A streamer's handle as the artist: "@janeplayskeys", "Jane (@janeplayskeys)". */
const STREAMER_HANDLE = /(?:^|[\s(])@([A-Za-z0-9_]{3,25})\)?\s*$/;
const songsLog = () => path.join(config.logDir, "songs.log");
const SONGS_LOG_LABEL: Record<Outcome, string> = {
  grounded: "article",
  wikidata: "wikidata",
  musicbrainz: "musicbrainz",
  songFacts: "yours",
  original: "original",
  liveLearn: "livelearn",
  noReference: "curated",
  nothingSurvived: "curated",
  generationFailed: "curated",
  factsOff: "off",
};

/** How each song's facts last turned out, so the dashboard can tell "nothing reliable" from "failed". */
const outcomes = new Map<string, Outcome>();
export const outcomeFor = (song: SSLSong): string => outcomes.get(songKey(song)) ?? "";

/** One line of logs/songs.log: time, title, artist field (without a note in brackets: issue #262), outcome, count. */
export function songsLogLine(song: SSLSong, outcome: Outcome, count: number, now = new Date()): string {
  const clean = (v: string) => (v ?? "").replace(/\s+/g, " ");
  return [now.toISOString(), clean(withoutRequestCredit(song.title)), clean(withoutArtistNote(song.artist ?? "")), SONGS_LOG_LABEL[outcome], count].join("\t") + "\n";
}

/** Count the outcome and append a line to logs/songs.log. */
function record(song: SSLSong, outcome: Outcome, count: number): void {
  factStats[outcome]++;
  factStats.lastOutcome = outcome;
  outcomes.set(songKey(song), outcome);
  if (process.env.NODE_ENV === "test") return;
  const line = songsLogLine(song, outcome, count);
  fs.mkdir(config.logDir, { recursive: true }, () => fs.appendFile(songsLog(), line, () => undefined));
}

/** Where each kind of fact comes from, as the dashboard labels it. */
export const SOURCE = {
  yours: "Your facts for this song",
  songList: "Your song list",
  custom: "Your custom facts",
  wikidata: "Wikidata",
  musicbrainz: "MusicBrainz",
  /** Followed by the article: "Wikipedia infobox: <article>". */
  infobox: "Wikipedia infobox: ",
} as const;

/** At most this many data facts (Wikidata, MusicBrainz, infobox) beside the captions written from an article. */
export const MAX_DATA_FACTS = 2;
/** The infobox field each infobox sentence was filled from, for the dashboard. */
const boxEvidence = new Map<string, string>();

/** Facts the streamer typed in go up as written; everything else must tell viewers something new. */
const WRITTEN_BY_STREAMER: ReadonlySet<string | undefined> = new Set([SOURCE.yours, SOURCE.custom]);

function toFacts(
  song: SSLSong,
  lines: string[],
  sourceOf: (text: string) => string | undefined = () => undefined,
  /** The Wikipedia reference the captions were written from, to show the streamer what each rests on. */
  context = "",
  /** The sentence each caption cites, when the model cited one. */
  cites: ReadonlyMap<string, string> = new Map()
): Fact[] {
  const told = lines.filter((text) => {
    if (WRITTEN_BY_STREAMER.has(sourceOf(text)) || !restatesRequest(text, song)) return true;
    console.log("[Screen] DROP (repeats the request)");
    return false;
  });
  const page = context.split("\n")[0];
  const spotFor = spotsForSong(song);
  return told.map((text, i) => {
    const source = sourceOf(text);
    const fromBox = Boolean(page) && source === `${SOURCE.infobox}${page}`;
    const fromArticle = (Boolean(page) && source === `Wikipedia: ${page}`) || fromBox;
    const evidence = fromBox ? (boxEvidence.get(text) ?? "") : fromArticle ? (cites.get(text) ?? supportingSentence(text, context)) : "";
    return {
      text,
      source,
      ...(fromArticle ? { url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.replace(/ /g, "_"))}` } : {}),
      ...(evidence ? { evidence } : {}),
      delaySeconds: i * config.factIntervalSeconds,
      durationSeconds: config.factDurationSeconds,
      ...spotFor(i),
    };
  });
}

// --- Prompts -----------------------------------------------------------

/**
 * The song as the prompt names it. A viewer typed the title, so it can't
 * close the quotes around it and pass itself off as part of the instructions.
 */
function promptWork(song: SSLSong): { game: string; work: string } {
  const { game: g, track: t } = resolveGameAndTrack(song);
  const [game, track] = [g, t].map((s) => s.replace(/"/g, "'"));
  return { game, work: track && track !== game ? `"${track}" from ${game}` : `"${track || game}"` };
}

function subjectLine(song: SSLSong): { game: string; intro: string } {
  const { game, work } = promptWork(song);
  // Nothing about the streamer goes in: an online AI gets the song and the article, no more (final QA #7).
  return {
    game,
    intro: `You are writing short trivia captions for a live music stream overlay. The song playing right now is ${work}.`,
  };
}

/**
 * CITE_SENTENCES=on: the CROSS prompt numbers the reference's sentences and has
 * the model cite the one each caption retells ("4 | caption"), so the screen
 * checks the caption against that sentence instead of guessing it
 * (`screenClaims` with `cited`). Off by default: a 3B model miscounts the
 * numbers, and the screen then dropped about five true captions for each wrong
 * one it caught. The rules prompt never cites.
 */
export const citesSentences = () => process.env.CITE_SENTENCES === "on" && process.env.PROMPT_STYLE !== "rules";

/**
 * The prompt, laid out as CROSS: Context, Role, Objective, Source, Scope.
 * PROMPT_STYLE=rules switches back to the numbered rule list in `groundedPrompt`.
 */
function crossPrompt(song: SSLSong, context: string, want: number): string {
  const { game, work } = promptWork(song);
  return citesSentences() ? citingCrossPrompt(game, work, context, want) : plainCrossPrompt(game, work, context, want);
}

/** The CROSS prompt's opening, the same with or without citations. */
function crossOpening(game: string, work: string, want: number): string {
  return `CONTEXT
A musician is playing ${work} live on a stream right now. Short captions about the song pop up on screen, one at a time, in small bubbles. The readers are the viewers in chat: music fans of every level, not experts.

ROLE
Act as a music trivia writer for live streams, who retells what a text says plainly and exactly.

OBJECTIVE
Write ${want} captions about ${game} or its music that chat would enjoy learning. In order of preference: what the people who made it said or did, who or what influenced it, how the music is built, and how it was received (charts, awards, sales). Do not add praise or opinions of your own.`;
}

/** The CROSS prompt's rules for retelling the text and for the captions, the same with or without citations. */
const RETELL_RULES = `Every person, year, number and title you write must appear in it, spelled the same way.`;
const STATEMENT_RULES = `never join two statements, and never move a name or a detail from one statement into another. Keep the statement's subject as your subject. Use a word of cause, order or count (because, due to, after, first, originally, twice) or a number only when that statement has it. Keep each detail with what it belongs to: a date with the release it dates, "second single from her third album" whole, every chart a position is on. Keep the statement's verb: "resembles" is not "inspired by", and what someone "described as" is their view, so name them. Write that someone said, described or recalled something only when the text says that person did, and quote only the text's own words. Keep "may have", "reportedly" and the like, and never make a claim bigger than the text: "one of the first" is not "the first". Name the group, chart or person: never "the duo", "the quartet" or "this chart" alone. If the text does not say something, leave it out.`;
/**
 * Worked examples, with made-up names, of the three slips a 3B model makes
 * most when it retells a sentence (algo loop, 2026-10): it drops who said or
 * thought something, so a view or a memory reads as fact; it keeps "it",
 * "they" or "these" from a sentence lifted out of its paragraph, so a viewer
 * takes it for the song playing; and it drops where, when or on which chart
 * ("in Japan", "by March 2009", "the UK top 40"), widening the claim. Shown as text to retell, a wrong line and a
 * right one, because a model this small copies an example better than it
 * applies a rule.
 */
export const RETELL_EXAMPLES = `EXAMPLES
Made-up text, to show how to retell. Never use these names or facts.
Text: According to producer Dana Reyes, the band wanted the chorus to sound like a storm.
Wrong: The band wanted the chorus to sound like a storm.
Right: Producer Dana Reyes said the band wanted the chorus to sound like a storm.
Text: Critic Sam Ortiz wrote that the album's lyrics are about growing up.
Wrong: The album's lyrics are about growing up.
Right: Critic Sam Ortiz wrote that the lyrics of the album are about growing up.
Text: Night Harbor was planned for 2003. It was delayed to May 2004.
Wrong: It was delayed to May 2004.
Right: Night Harbor was delayed to May 2004.
Text: In Japan, "Paper Lanterns" sold 40,000 copies by March 2009 and reached number 9 on the Oricon chart.
Wrong: "Paper Lanterns" sold 40,000 copies and reached the top 10.
Right: In Japan, "Paper Lanterns" sold 40,000 copies by March 2009.
Always name who said, wrote or thought something, and keep where, when and on which chart. Never start with "it", "they", "these" or "the records": use the name the text gives, or skip the statement.`;

/** Words too common to tell an example's wording from the reference's: three of them in a row prove nothing. */
const COMMON_WORDS = new Set("the of a an s are is was were to in on and it its that by for with as about lyrics album song band said wrote".split(" "));
const words = (text: string) => text.toLowerCase().replace(/(\d),(\d)/g, "$1$2").match(/[a-z0-9]+/g) ?? [];
const threeWords = (list: string[]) => list.slice(0, -2).map((w, i) => `${w} ${list[i + 1]} ${list[i + 2]}`);
/** Every run of three words in the examples' lines that isn't all common words. */
const EXAMPLE_WORDING = new Set(
  RETELL_EXAMPLES.split("\n")
    .filter((l) => /^(Text|Wrong|Right): /.test(l))
    .flatMap((l) => threeWords(words(l.replace(/^\w+: /, ""))))
    .filter((g) => g.split(" ").some((w) => !COMMON_WORDS.has(w)))
);

/**
 * A caption that copies the examples instead of the reference: three words in
 * a row from an example ("sound like a storm", "reached number 9") that the
 * reference doesn't have. A 3B model sometimes pins an example's made-up
 * story on a real name ("<the game's composer> said the band wanted the
 * chorus to sound like a storm"), which no other screen catches when the
 * name is in the reference.
 */
export function copiesExample(caption: string, context: string): boolean {
  const source = ` ${words(context).join(" ")} `;
  return threeWords(words(caption)).some((g) => EXAMPLE_WORDING.has(g) && !source.includes(` ${g} `));
}
const CAPTION_RULES = `Nothing about the music video. Skip release dates, record labels, catalog numbers and formats unless the text has nothing better. Never mention the text, this prompt or what you could not find.`;

function plainCrossPrompt(game: string, work: string, context: string, want: number): string {
  return `${crossOpening(game, work, want)}

${RETELL_EXAMPLES}

SOURCE
Use only the text between the triple quotes. ${RETELL_RULES} Each line retells ONE statement from the text: ${STATEMENT_RULES}
"""
${context}
"""

SCOPE
Exactly ${want} lines. One calm sentence per line, about 10 to 18 words and under 120 characters, in plain words anyone can follow. No exclamation marks, numbering, bullets, headings or wrapping quotes. ${CAPTION_RULES}`;
}

function citingCrossPrompt(game: string, work: string, context: string, want: number): string {
  return `${crossOpening(game, work, want)}

${RETELL_EXAMPLES}

SOURCE
Use only the text between the triple quotes. Its sentences are numbered in square brackets. ${RETELL_RULES} Each line retells ONE numbered sentence: ${STATEMENT_RULES}
"""
${numberedReference(context)}
"""

SCOPE
Exactly ${want} lines. Start each line with the number of the sentence it retells, then " | ", then the caption, like this:
4 | The caption.
Each caption is one calm sentence, about 10 to 18 words and under 120 characters, in plain words anyone can follow. No exclamation marks, bullets, headings or wrapping quotes. ${CAPTION_RULES}`;
}

/**
 * Written for a 3B model: the source comes first, and every rule is a test
 * the model can apply to its own sentence rather than "be accurate".
 */
function groundedPrompt(song: SSLSong, context: string, want: number): string {
  // CROSS is the default: in trials it followed the rules better and gave more reception facts (issue #48).
  if (process.env.PROMPT_STYLE !== "rules") return crossPrompt(song, context, want);
  const { game, intro } = subjectLine(song);
  return `${intro}

Everything you write must come from the SOURCE below. It is the only information you are allowed to use.

SOURCE
"""
${context}
"""

Write exactly ${want} trivia lines about ${game} or its music. Your readers are the stream's chat: pick what they would find surprising, funny or fascinating, the kind of thing someone repeats to a friend. Skip dry details (labels, catalog numbers, release formats) unless the SOURCE has nothing better.

Follow every rule:
1. Use ONLY the SOURCE. Every person, year, number, platform, studio, and title you write must appear in the SOURCE, spelled the same way.
2. Match the SOURCE's subject. If it describes a song, film, or classical work rather than a video game, write about that — never force a gaming angle onto music that has nothing to do with games.
3. Each line restates ONE statement from the SOURCE. Never merge two statements, and never move a name from one statement into another — if the SOURCE says someone composed the music, do not say they wrote the story or designed the game. Keep the statement's subject as your subject, and use a word of cause, order or count (because, due to, after, first, originally, twice) or a number only when that statement has it. Keep each detail with what it belongs to (a date with the release it dates, "second single from her third album" whole), and keep the statement's verb: "resembles" is not "inspired by", and what someone "described as" is their view, so name them. Write that someone said, described or recalled something only when the SOURCE says that person did, and quote only the SOURCE's own words. Keep "may have", "reportedly" and the like, and name the group, chart or person instead of "the duo" or "this chart".
4. If the SOURCE does not name a composer, do NOT name a composer — write about a different detail the SOURCE does give.
5. Do not mention awards, sales, chart positions, or review scores unless the SOURCE uses those words.
   Never write opinions or praise ("considered", "acclaimed", "one of the greatest"), even if the SOURCE quotes them.
   Never describe the music video: viewers are watching it. Write about the song itself.
6. Prefer what the people who made the music said or did. If the SOURCE says someone "said", "recalled" or was "inspired by" something, retell that in your own words and keep their name. Then who or what influenced it, how the music is built (key, tempo, chords, form), and how it was received (a chart position, award, certification or sales), when the SOURCE gives them. Then the instruments and how it was recorded, arranged or first performed.
7. Never mention the SOURCE, this prompt, Wikipedia, or anything you could not find. Write finished facts only.
8. One sentence per line, under 120 characters, friendly like a loading-screen tip, in plain words anyone can follow.
9. No numbering, bullets, quotes, or headings. Output exactly ${want} lines and nothing else.`;
}

/** Used only with FACT_VERIFICATION=off: fast, from memory, often wrong. */
function unverifiedPrompt(song: SSLSong, want: number): string {
  const { game, intro } = subjectLine(song);
  return `${intro}

Write exactly ${want} trivia lines about ${game} or its music.

Follow every rule:
1. Write only things you are confident are true. If you are unsure who composed the music, do not name a composer.
2. Do not mention awards, sales, chart positions, or review scores.
3. Never mention this prompt or say what you could not find. Write finished facts only.
4. One sentence per line, under 120 characters, friendly like a loading-screen tip.
5. No numbering, bullets, quotes, or headings. Output exactly ${want} lines and nothing else.`;
}

// --- Providers ---------------------------------------------------------

/**
 * The system prompt every provider gets. Without one, node-llama-cpp gives the
 * built-in model its own "helpful assistant" prompt, which Ollama never sends,
 * so the shipped model and the one measured through Ollama were told different things.
 */
export const SYSTEM_PROMPT =
  "You write short trivia captions for a live music stream. You use only the reference text you are given, and you follow the instructions exactly.";

/** With FACT_VERIFICATION=off the AI gets no reference, so its system prompt doesn't mention one (#202). */
const UNVERIFIED_SYSTEM_PROMPT = "You write short trivia captions for a live music stream, and you follow the instructions exactly.";
export const systemPrompt = () => (config.factVerification ? SYSTEM_PROMPT : UNVERIFIED_SYSTEM_PROMPT);

let anthropic: import("@anthropic-ai/sdk").default | undefined;

async function askAnthropic(prompt: string): Promise<string> {
  if (!anthropic) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  const res = await anthropic.messages.create({
    model: config.anthropicModel,
    max_tokens: MAX_TOKENS,
    temperature: config.temperature,
    system: systemPrompt(),
    messages: [{ role: "user", content: prompt }],
  });
  return res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

async function postJSON<T>(url: string, body: unknown, timeoutMs: number, headers = {}): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/** Groq, OpenRouter, Gemini, LM Studio, vLLM: anything speaking chat completions. */
async function askOpenAICompatible(prompt: string): Promise<string> {
  const data = await postJSON<{ choices?: Array<{ message?: { content?: string } }> }>(
    `${config.openaiBaseUrl}/chat/completions`,
    {
      model: config.openaiModel,
      messages: [
        { role: "system", content: systemPrompt() },
        { role: "user", content: prompt },
      ],
      temperature: config.temperature,
      max_tokens: HOSTED_MAX_TOKENS,
    },
    config.openaiTimeoutMs,
    { Authorization: `Bearer ${config.openaiApiKey}` }
  );
  return data.choices?.[0]?.message?.content ?? "";
}

/** Primary Ollama host, then the fallback host if one is configured. Returns the text and the host that answered. */
async function askOllama(prompt: string): Promise<[string, string]> {
  const hosts = [config.ollamaBaseUrl, config.ollamaFallbackUrl].filter(Boolean);
  let lastError: unknown;
  for (const host of hosts) {
    try {
      const data = await postJSON<{ response: string }>(
        `${host}/api/generate`,
        {
          model: config.ollamaModel,
          system: systemPrompt(),
          prompt,
          stream: false,
          keep_alive: config.ollamaKeepAlive,
          options: { temperature: config.temperature, num_predict: MAX_TOKENS },
        },
        config.ollamaTimeoutMs
      );
      return [data.response, host];
    } catch (err) {
      lastError = err;
      console.warn(`[FactGen] Ollama at ${host} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  throw lastError;
}

// node-llama-cpp is an ES module. A plain import() would be compiled to require()
// under CommonJS and fail, so the import is kept out of the compiler's reach.
const importModule = new Function("specifier", "return import(specifier)") as (s: string) => Promise<any>;

/** The loaded model and one reusable chat session. Loading takes a few seconds, so it happens once. */
let builtin: Promise<{ session: any }> | undefined;

function loadBuiltin(): Promise<{ session: any }> {
  builtin ??= (async () => {
    const { getLlama, LlamaChatSession } = await importModule("node-llama-cpp");
    // Only the prebuilt binaries shipped with the app: never download and compile llama.cpp on a musician's computer.
    const llama = await getLlama({ build: "never", ...(config.llamaGpu === "off" ? { gpu: false } : {}) });
    const model = await llama.loadModel({ modelPath: config.modelPath });
    const context = await model.createContext({ contextSize: 4096 });
    const session = new LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt: systemPrompt() });
    console.log(`[FactGen] Built-in model loaded (${llama.gpu || "cpu"})`);
    return { session };
  })().catch((err) => {
    builtin = undefined; // Let the next song retry the load.
    throw err;
  });
  return builtin;
}

/**
 * Load the built-in model at start-up rather than on the first song, so the
 * first song isn't slowed by loading and a load failure shows immediately.
 * The desktop app watches for the two log lines below.
 */
export async function warmUpBuiltin(): Promise<void> {
  if (config.aiProvider !== "builtin") return;
  try {
    await loadBuiltin();
  } catch (err) {
    console.error(`[FactGen] Built-in model failed to load: ${err instanceof Error ? err.message : err}`);
  }
}

/** Longest the built-in model may write for one song before it's stopped. */
const BUILTIN_TIMEOUT_MS = 90_000;
let builtinQueue: Promise<unknown> = Promise.resolve();

/** A song that's no longer on stream: its queued or running AI work is dropped. */
class Obsolete extends Error {}
/** The song on stream now, set by the server; null when unknown (tests, the self-test). */
let currentKey: string | null = null;
let running: { key: string | null; stop: AbortController } | null = null;

/**
 * The server says which song is on stream. Work for any other song is no
 * longer wanted: the running generation stops now, and queued ones are skipped
 * when their turn comes, so skipping songs quickly can't build a backlog in
 * front of the current one.
 */
export function setCurrentSong(song: SSLSong | null): void {
  currentKey = song ? songKey(song) : null;
  if (running?.key && running.key !== currentKey) running.stop.abort();
}
const obsolete = (key: string | null) => key !== null && currentKey !== null && key !== currentKey;

/**
 * The desktop app's built-in model. There is one chat session, so songs take
 * turns: resetting the history and prompting happen together, inside the
 * queue, or a song that changes mid-generation would inherit the previous
 * song's conversation. Each turn is cut off after BUILTIN_TIMEOUT_MS; what
 * was written so far is still screened like any other output.
 */
function askBuiltin(prompt: string, key: string | null = null): Promise<string> {
  const run = async () => {
    if (obsolete(key)) throw new Obsolete();
    const { session } = await loadBuiltin();
    session.resetChatHistory();
    const stop = new AbortController();
    running = { key, stop };
    try {
      const text = (await session.prompt(prompt, {
        temperature: config.temperature,
        maxTokens: MAX_TOKENS,
        signal: AbortSignal.any([AbortSignal.timeout(BUILTIN_TIMEOUT_MS), stop.signal]),
        stopOnAbortSignal: true,
      })) as string;
      if (stop.signal.aborted) throw new Obsolete();
      return text;
    } finally {
      running = null;
    }
  };
  const turn = builtinQueue.then(run, run);
  builtinQueue = turn.catch(() => undefined);
  return turn;
}

async function askModel(prompt: string, key: string | null = null): Promise<string> {
  const started = Date.now();
  let text: string;
  let endpoint: string;
  if (config.aiProvider === "builtin") {
    text = await askBuiltin(prompt, key);
    endpoint = "built-in model";
  } else if (config.aiProvider === "anthropic") {
    text = await askAnthropic(prompt);
    endpoint = `anthropic (${config.anthropicModel})`;
  } else if (config.aiProvider === "openai") {
    text = await askOpenAICompatible(prompt);
    endpoint = `${config.openaiBaseUrl} (${config.openaiModel})`;
  } else {
    [text, endpoint] = await askOllama(prompt);
  }
  factStats.lastEndpoint = endpoint;
  factStats.lastDurationMs = Date.now() - started;
  console.log(`[FactGen] ${endpoint} answered in ${(factStats.lastDurationMs / 1000).toFixed(1)}s`);
  return text;
}

// --- Pipeline ----------------------------------------------------------

/**
 * Plain facts about the song itself: Wikidata first, then MusicBrainz, unless marked wrong for it.
 * `reading` is the reading of the song to look up; the bookkeeping stays with the song as requested.
 */
async function structuredFacts(song: SSLSong, reading: SSLSong = song, sure: Promise<SureArticle | null> = Promise.resolve(null)): Promise<string[]> {
  if (blockedArticles(song).has(STRUCTURED)) return [];
  const names = [reading.title, reading.artist ?? ""];
  const data = onStandard(await wikidataFacts(reading), names);
  let facts = data;
  if (!data.length) {
    // The article's item is read alongside MusicBrainz. When MusicBrainz has facts, they don't
    // wait for it: it adds to them only if it is already in (it is cached for the next play).
    const item = sure.then((found) => (found ? articleItem(found.page, found.names, requestTitles(song, reading)) : null));
    const mb = await musicbrainzFacts(reading);
    const found = mb.length ? await Promise.race([item, Promise.resolve(null)]) : await item;
    const fromItem = found?.kind === "song" ? songItemFacts(found, { year: statedYear(mb), album: statesAlbum(mb) }) : { facts: found?.facts ?? [], dropYear: false };
    const fromMb = onStandard(fromItem.dropYear ? withoutYear(mb) : mb, names);
    const added = onStandard(fromItem.facts, [...names, found?.kind === "song" ? found.title : ""]).filter((f) => !fromMb.includes(f));
    for (const f of fromMb) structuredLabel.set(f, SOURCE.musicbrainz);
    for (const f of added) structuredLabel.set(f, SOURCE.wikidata);
    facts = [...fromMb, ...added];
  } else for (const f of data) structuredLabel.set(f, SOURCE.wikidata);
  structuredShown.set(songKey(song), new Set(facts));
  return facts;
}

/** The titles a request may go by: as typed and as read, whole and without a game's name in front. */
function requestTitles(song: SSLSong, read: SSLSong): string[] {
  return [...new Set([song, read].flatMap((s) => [s.title, resolveGameAndTrack(s).track]).filter(Boolean))];
}

/**
 * The infobox's facts when the infobox is about the requested work, else none (`boxMisfit`):
 * not a remake's, a same-named game's for a band, or another album's in a music article.
 * A game's infobox also asks MusicBrainz (cached) whether the artist field is a performer
 * with this song.
 */
async function boxForRequest(list: BoxFact[], page: string, song: SSLSong, read: SSLSong): Promise<BoxFact[]> {
  const about = list.find((b) => b.about)?.about;
  if (!about) return list;
  const { game } = resolveGameAndTrack(read);
  const titles = requestTitles(song, read);
  const performer = about.kind === "game" ? await musicbrainzFacts(read).then((mb) => Boolean(statedYear(mb) || statesAlbum(mb))) : false;
  const why = boxMisfit(about, { game, titles }, performer);
  if (why) {
    console.log(`[Infobox] "${page}": ${why}, no infobox facts`);
    return [];
  }
  return list;
}

/** An article the lookup surely matched to the request: its page and the request's artist names. */
interface SureArticle {
  page: string;
  names: string[];
}

/**
 * The request's article when it is surely this work (issue #256), for its Wikidata item's
 * facts: the same lookup and checks as the AI's reference (`findReference`,
 * `workMatchConfidence`, `summaryGate`). Null when there is none or it may be another
 * work. Never throws.
 */
async function sureArticle(song: SSLSong): Promise<SureArticle | null> {
  try {
    const { context, read } = await findReference(song);
    if (!context || workMatchConfidence(read, context, song).level !== "sure" || (await summaryGate(read, context, song))) return null;
    const names = [...new Set([...artistNames(song.artist ?? ""), ...artistNames(read.artist ?? "")])];
    return { page: context.split("\n")[0], names };
  } catch (err) {
    console.warn(`[Grounding] Lookup for data facts failed for "${song.title}": ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Facts from data that meet the content standard, as captions must (issue #242). Logged by reason alone.
 * `names`: the song's title and artist, read as names ("Smooth Criminal").
 */
function onStandard(facts: string[], names: string[] = []): string[] {
  return facts.filter((f) => {
    const reason = standardBreach(f, names);
    if (reason) console.log(`[Screen] DROP data fact (${reason})`);
    return !reason;
  });
}

/**
 * Facts from data alone (Wikidata, MusicBrainz), the most interesting first and at most
 * MAX_BUBBLES of them (`rankFacts`). SOURCE_RISK=off keeps them as found.
 */
function rankedData(data: string[], want: number): string[] {
  if (!config.sourceRisk) return data.slice(0, want);
  return rankFacts(data.map((text) => ({ text, kind: "data" as const })), { max: Math.min(want, MAX_BUBBLES) }).map((c) => c.text);
}

/** For the saved session: the recent facts, and putting them back after a restart. */
export const recentShown = (): string[] => [...recentFacts];
export function restoreRecent(list: string[]): void {
  recentFacts.length = 0;
  recentFacts.push(...list.slice(-RECENT_KEPT));
}
/** Facts sent before a restart stand as this song's facts: nothing is generated again. */
export function primeFacts(song: SSLSong, facts: Fact[]): void {
  factCache.set(songKey(song), { facts, expires: Infinity });
}

/** Remember facts as shown, keeping only the last RECENT_KEPT. */
function remember(shown: string[]): void {
  recentFacts.push(...shown);
  recentFacts.splice(0, Math.max(0, recentFacts.length - RECENT_KEPT));
}

/** Whether the reference is the song's own article, rather than its artist's or game's. */
function aboutTheSong(song: SSLSong, context: string): boolean {
  const { game, track } = resolveGameAndTrack(song);
  if (!track || track === game) return true;
  return mentionsName(normalizeTitle(context.split("\n")[0]), [normalizeTitle(track)]);
}

/** Articles passed over for one request before giving up on a reading. */
const MAX_MISFITS = 2;

/**
 * A reference for one reading of the request that fits it (`articleMisfit`):
 * an article whose opening isn't about music or a work, or that never names
 * what the request's brackets name, is passed over and the lookup tried again
 * without it ("Jezebel" by Sade finds the singer instead of the queen).
 */
async function fittingGrounding(song: SSLSong, reading: SSLSong): Promise<string> {
  const skip = new Set<string>();
  for (;;) {
    const found = await fetchGrounding(reading, skip);
    const why = found ? articleMisfit(song, found) : "";
    if (!why) return found;
    const page = found.split("\n")[0];
    console.log(`[Grounding] "${page}" ${why}, skipping`);
    skip.add(page);
    if (skip.size >= MAX_MISFITS) return "";
  }
}

/**
 * The reference for a request and the reading that found it ("" when none): each reading of
 * the song list's habits is tried until one finds an article.
 */
export async function findReference(song: SSLSong): Promise<{ context: string; read: SSLSong }> {
  let context = "";
  let read = song;
  for (const reading of readings(song)) {
    const found = await fittingGrounding(song, reading);
    if (!found) continue;
    // The artist's life story is the weakest find: kept, but another reading may find the song or its game.
    const onlyTheArtist = artistNames(reading.artist ?? "").includes(normalizeTitle(found.split("\n")[0]));
    if (context && onlyTheArtist) continue;
    context = found;
    read = reading;
    if (!onlyTheArtist) break;
  }
  return { context, read };
}

/** Facts from the queue entry, topped up from the topic packs. True by construction. */
function entryFacts(entry: SSLQueueItem | null, want: number): string[] {
  const stats = buildStatFacts(entry, { streamerName: config.sslStreamerName }).slice(0, want);
  for (const s of stats) statLines.add(s);
  return [...stats, ...curatedFacts(want - stats.length)];
}

/** Lines built from the song list, so the dashboard can tell them from custom facts. */
const statLines = new Set<string>();
const entrySource = (t: string) => (statLines.has(t) ? SOURCE.songList : SOURCE.custom);

/**
 * The streamer's custom facts tagged for this song: "[Song of Storms] ...",
 * "[Chopin] ...", "[Undertale] ...". The tag is the title, the artist or the
 * game, compared without case, accents or punctuation, and without the
 * version tags song lists add ("Take On Me [Instrumental]"). A tag that names
 * a version itself ("[Night Drive (Acoustic)]") goes only with that version,
 * compared the way song-facts.ts compares the streamer's own records.
 */
export function taggedFactsFor(song: SSLSong): string[] {
  const { forSong, pool } = taggedFor(song);
  return [...forSong, ...pool];
}

/**
 * Tagged facts split by what the tag names: this song (`forSong`), or its
 * artist or game (`pool`), which every song by that artist or from that game shares.
 */
function taggedFor(song: SSLSong): { forSong: string[]; pool: string[] } {
  if (!topic.taggedFacts?.length) return { forSong: [], pool: [] };
  const { game, track } = resolveGameAndTrack(song);
  const named = (list: (string | undefined)[]) => new Set(list.map((s) => normalizeTitle(s ?? "")).filter(Boolean));
  const titles = named([song.title, track, `${song.artist} ${song.title}`]);
  const shared = named([game, ...artistNames(song.artist ?? "")]);
  // Each title with its trailing brackets taken off one at a time: "Night Drive (Acoustic) [Instrumental]"
  // is also "Night Drive (Acoustic)", but never "Night Drive (Remix)".
  const peeled = (s: string) => {
    const out = [s];
    for (let m; (m = /^(.+?)\s*[([][^)\]]*[)\]]\s*$/.exec(out[out.length - 1])); ) out.push(m[1]);
    return out;
  };
  const versions = new Set(
    [song.title, track, `${song.artist} ${song.title}`].flatMap((s) => peeled(s ?? "")).map(songIdentity).filter(Boolean)
  );
  const forSong: string[] = [];
  const pool: string[] = [];
  for (const f of topic.taggedFacts) {
    const tag = f.tag.replace(/\s+[-–—]\s+/, " ");
    if (dropVersionTags(tag) !== tag) {
      if (versions.has(songIdentity(tag))) forSong.push(f.text);
    } else if (titles.has(normalizeTitle(tag))) forSong.push(f.text);
    else if (shared.has(normalizeTitle(tag))) pool.push(f.text);
  }
  return { forSong, pool };
}

/** `n` facts from an artist's or game's pool, the longest unused first, in the order written. */
function takeTurns(pool: string[], n: number): string[] {
  const picked = pool
    .map((text, i) => ({ text, i, turn: poolTurns.get(text) ?? -1 }))
    .sort((a, b) => a.turn - b.turn || a.i - b.i)
    .slice(0, n)
    .map((p) => p.text);
  for (const text of picked) poolTurns.set(text, ++poolTurn);
  return picked;
}

/** Facts about the song itself, from a source, rather than written by the streamer or built from the song list. */
const fromASource = (f: Fact) => !WRITTEN_BY_STREAMER.has(f.source) && f.source !== SOURCE.songList;

/**
 * The streamer's facts tagged for this song first, as written. Facts tagged for its
 * artist or game take turns: one per song beside the facts about the song itself,
 * or, when no source knows the song, as many as there are bubbles. Then the usual
 * facts in the slots left.
 */
async function generate(song: SSLSong, entry: SSLQueueItem | null, onEarly?: EarlyFacts): Promise<{ facts: Fact[]; ttlMs: number }> {
  const want = config.factsPerSong;
  // A song with its own facts takes its pool fact there (generateRest).
  const tagged = findSongFacts(song) ? { forSong: [], pool: [] } : taggedFor(song);
  const mine = tagged.forSong.slice(0, want);
  // With the streamer's tagged facts mixed in, the facts are re-spaced at the end: they go out once.
  if (!mine.length && !tagged.pool.length) return generateRest(song, entry, want, false, song, onEarly);
  const room = want - mine.length;
  const rest = room > 0 ? await generateRest(song, entry, room) : { facts: [], ttlMs: Infinity };
  const found = rest.facts.filter((f) => !mine.includes(f.text) && !tagged.pool.includes(f.text));
  const known = found.some(fromASource);
  const pool = room > 0 ? takeTurns(tagged.pool, known ? 1 : room) : [];
  const others = found.slice(0, room - pool.length);
  console.log(`[FactGen] "${song.title}": ${mine.length + pool.length} of the streamer's own facts are for this song`);
  // The first bubble stays about the song: its own tagged facts, else the first fact found about it.
  const first = mine.length ? undefined : others.find(fromASource);
  const lead = first ? [first.text] : mine;
  const lines = [...lead, ...pool, ...others.map((f) => f.text).filter((t) => !lead.includes(t))];
  // Labeled as custom facts: that's where the streamer edits them.
  const theirs = new Set([...mine, ...pool]);
  const sourceOf = (t: string) => (theirs.has(t) ? SOURCE.custom : others.find((f) => f.text === t)?.source);
  // Re-spacing rebuilds each fact, so the article link and source sentence are carried across.
  const sourced = new Map(others.map((f) => [f.text, f]));
  const facts = toFacts(song, lines, sourceOf).map((f) => {
    const was = sourced.get(f.text);
    return was ? { ...f, ...(was.url ? { url: was.url } : {}), ...(was.evidence ? { evidence: was.evidence } : {}) } : f;
  });
  return { facts, ttlMs: rest.ttlMs };
}

/**
 * What to look up for a live learn: the request as typed, or, when no artist
 * was given, the artist and title read from it the way a YouTube title is
 * read ("Rick Astley - Never Gonna Give You Up (Official Video)"). Null when
 * no artist can be told: a bare title is too easy to mismatch.
 */
export function liveLearnLookup(song: SSLSong): SSLSong | null {
  const artist = (song.artist ?? "").trim();
  if (artist && !hasNoArtist(artist)) return { title: song.title, artist };
  const parsed = parseVideoTitle(song.title);
  if (!parsed.artist || !parsed.title) return null;
  return { title: parsed.title, artist: parsed.artist, ...(parsed.performer ? { performer: true } : {}), ...(parsed.confident ? {} : { artistUncertain: true }) };
}

/**
 * A now playing song with no artist, read with the one artist MusicBrainz has
 * its exact title from (`artistByTitle`), marked so only facts from data show.
 * Null when it names an artist, or no single artist has the title.
 */
async function titleOnlyReading(song: SSLSong): Promise<SSLSong | null> {
  if (!song.titleOnly || !config.factVerification) return null;
  const artist = await artistByTitle(song.title);
  if (!artist) return null;
  console.log(`[FactGen] "${song.title}" has no artist: looked up as by ${artist}, the only artist with this title`);
  return { ...song, artist, titleOnly: undefined, artistFromTitle: true };
}

/** Facts for a song, and how long to keep them (0: not cached, Infinity: for the session). */
type Generated = { facts: Fact[]; ttlMs: number };

/**
 * Facts the streamer wrote for this very song come first, exactly as written, with no
 * lookup, even for a live learn: often another music content creator's off-list original.
 * Null when they wrote none.
 */
function ownSongFacts(song: SSLSong, want: number, asked: SSLSong): Generated | null {
  const ownRecord = findSongFacts(song);
  // A record with only a switch on it ("No facts for this song") has nothing of its own to show.
  if (!ownRecord || !hasOwnFacts(ownRecord)) return null;
  const lines = songFactLines(ownRecord, want);
  // With room left, one fact from its artist's or game's pool, ahead of the creator's link.
  const pool = lines.length < want ? takeTurns(taggedFor(song).pool, 1) : [];
  lines.splice(ownRecord.link?.trim() ? lines.length - 1 : lines.length, 0, ...pool);
  console.log(`[FactGen] "${song.title}": ${lines.length} of the streamer's own facts for this song`);
  record(asked, "songFacts", lines.length);
  // Not cached: an edit in the app applies the next time it plays.
  return { facts: toFacts(song, lines, (t) => (pool.includes(t) ? SOURCE.custom : SOURCE.yours)), ttlMs: 0 };
}

/** A live learn: facts from a source when one knows the song, else none (the overlay shows its banner). */
async function liveLearnFacts(song: SSLSong, want: number, asked: SSLSong): Promise<Generated> {
  // The LIVE LEARN banner still shows. A well-known song gets its facts too (issue #45);
  // one no source knows gets none, never filler.
  const lookup = config.factVerification && config.aiProvider !== "none" ? liveLearnLookup(song) : null;
  const found = lookup ? await generateRest(lookup, null, want, true, song) : { facts: [] as Fact[], ttlMs: Infinity };
  if (found.facts.length) {
    console.log(`[FactGen] "${song.title}" is a live learn: ${found.facts.length} facts, looked up as "${lookup?.title}" by ${lookup?.artist}`);
    return found;
  }
  console.log(`[FactGen] "${song.title}" is a live learn with nothing to look up or find, so no facts`);
  record(asked, "liveLearn", 0);
  return { facts: [], ttlMs: found.ttlMs };
}

/** The streamer's original: facts from its queue entry and their notes, no lookup. Null when it isn't one. */
function originalFacts(song: SSLSong, entry: SSLQueueItem | null, want: number, asked: SSLSong): Generated | null {
  const names = [config.sslStreamerName, config.streamerDisplayName];
  if (!(config.originals && isOriginal(entry, names))) return null;
  const stats = buildStatFacts(entry, { streamerName: config.sslStreamerName, isOriginalSong: true, names });
  // The streamer's notes about their own compositions go first, but only with their own pieces.
  // Two per play, picked at random, so the same notes don't fill every original.
  const notes = isOwnOriginal(entry, names) ? [...topic.originalsFacts].sort(() => Math.random() - 0.5) : [];
  const statSet = new Set(stats);
  const lines = [...notes.slice(0, 2), ...stats, ...notes.slice(2)];
  const facts = toFacts(song, lines, (t) => (statSet.has(t) ? SOURCE.songList : SOURCE.custom)).slice(0, want);
  console.log(`[FactGen] "${song.title}" is an original: ${facts.length} facts from the song entry`);
  record(asked, "original", facts.length);
  // Not cached: requester and play count change, and this path is free.
  return { facts, ttlMs: 0 };
}

/**
 * Facts from a reference: the article for a reading of the request, written up by the model and
 * screened, or Wikidata and MusicBrainz when there is no article or it may not be this song's;
 * the song list's and custom facts when nothing is found (unless `sourcedOnly`).
 */
async function groundedFacts(song: SSLSong, entry: SSLQueueItem | null, want: number, sourcedOnly: boolean, asked: SSLSong, onEarly?: EarlyFacts): Promise<Generated> {
  const none = { facts: [] as Fact[], ttlMs: RETRY_MS };
  // Streamers write their lists differently ("Game - Track" with the composer as artist,
  // "Track (Film)"...). Each reading is tried until one finds an article; `read` is that one.
  let context = "";
  let read = song;
  // "Jane (@janeplayskeys)": another music content creator's piece. No encyclopedia knows it, so nothing is looked up.
  const handle = STREAMER_HANDLE.exec(song.artist ?? "")?.[1];
  if (handle) console.log(`[FactGen] "${song.title}" is credited to a streamer (@${handle}): not looked up`);
  // "Off-List YouTube Request < 5 Min (Free)": a slot in the queue, not a song. Its "article" would be YouTube's.
  const placeholder = isPlaceholderRequest(song);
  if (placeholder) console.log(`[FactGen] "${song.title}" is a request placeholder, not a song: not looked up`);
  if (config.aiProvider !== "none" && config.factVerification && !handle && !placeholder) {
    ({ context, read } = await findReference(song));
    if (read !== song) console.log(`[FactGen] "${song.title}" read as "${read.title}" from ${read.artist}`);
  }
  // No AI available (the desktop app's fallback when its model can't run), or no article:
  // facts from data, else song-list and hand-picked facts.
  if (config.aiProvider === "none" || (config.factVerification && !context)) {
    const lookup = config.factVerification && !handle && !placeholder;
    // With no AI, the article is still looked up, alongside the data: when it is surely this
    // song or its artist, its own Wikidata item adds facts (issue #256). Never for an unsure one.
    const sure = lookup && config.aiProvider === "none" ? sureArticle(song) : Promise.resolve(null);
    // No article: plain facts from Wikidata, then MusicBrainz, need no AI (issue #23).
    const data = lookup ? await structuredFacts(song, read, sure) : [];
    const shownData = rankedData(data.filter((f) => !recentFacts.includes(f) && !restatesRequest(f, song)), want);
    if (shownData.length) {
      remember(shownData);
      record(asked, structuredLabel.get(shownData[0]) === SOURCE.musicbrainz ? "musicbrainz" : "wikidata", shownData.length);
      return { facts: toFacts(song, shownData, (t) => structuredLabel.get(t)), ttlMs: Infinity };
    }
    if (sourcedOnly) return none;
    const lines = entryFacts(entry, want);
    console.log(`[FactGen] No reference for "${song.title}": using ${lines.length} entry and curated facts`);
    record(asked, "noReference", lines.length);
    // Retried after the grounding negative cache expires.
    return { facts: toFacts(song, lines, entrySource), ttlMs: RETRY_MS };
  }

  // Not sure the article is about this song (issue #255): no AI captions, only facts from data.
  // Wikipedia's own summary of the article can say so too: a disambiguation page, a film named like the song.
  let match = context && config.abstain ? workMatchConfidence(read, context, song) : null;
  // An artist found by the title alone may be another song's: never more than data facts.
  if (context && song.artistFromTitle && match?.level !== "unsure") match = { level: "unsure", reason: "the artist was found by the title alone" };
  if (match?.level === "sure") {
    const why = await summaryGate(read, context, song);
    if (why) match = { level: "unsure", reason: why };
  }
  if (match?.level === "unsure") {
    console.log(`[Grounding] unsure: ${match.reason} ("${context.split("\n")[0]}" for "${song.title}"), showing facts from data only`);
    const fresh = (list: string[]) => list.filter((f) => !recentFacts.includes(f) && !restatesRequest(f, song));
    const data = fresh(await structuredFacts(song, read));
    // Too few to fill the song: up to two about its artist or game, from Wikidata too.
    const { game } = resolveGameAndTrack(read);
    const page = context.split("\n")[0];
    const about = isPerformerArticle(page, articleText(page) || context) ? page : game;
    const extra = data.length + taggedFor(song).pool.length < 2 ? fresh(onStandard(await artistFacts(about), [about])).slice(0, 2) : [];
    for (const f of extra) structuredLabel.set(f, SOURCE.wikidata);
    const shown = rankedData([...data, ...extra.filter((f) => !data.includes(f))], want);
    if (shown.length) {
      remember(shown);
      record(asked, structuredLabel.get(shown[0]) === SOURCE.musicbrainz ? "musicbrainz" : "wikidata", shown.length);
      return { facts: toFacts(song, shown, (t) => structuredLabel.get(t)), ttlMs: Infinity };
    }
    if (sourcedOnly) return none;
    const lines = entryFacts(entry, want);
    record(asked, "noReference", lines.length);
    return { facts: toFacts(song, lines, entrySource), ttlMs: RETRY_MS };
  }

  // Facts from data about the song, looked up alongside the AI: when the article is about its
  // artist or game ("describe the song, then tell about it"), or surely about the song itself,
  // when its own Wikidata item can add to them (issue #256). They go to the overlay as soon as
  // they're ready (`onEarly`), so a busy PC shows them while the AI is still writing.
  const page = context.split("\n")[0];
  const sure = context && match?.level === "sure" ? { page, names: [...new Set([...artistNames(song.artist ?? ""), ...artistNames(read.artist ?? "")])] } : null;
  // Data facts leave room for at least one caption, and are never more than MAX_DATA_FACTS.
  const dataRoom = Math.min(MAX_DATA_FACTS, want > 1 ? want - 1 : want);
  let aiDone = false;
  let early: Fact[] = [];
  const dataFacts = (context && (!aboutTheSong(read, context) || sure) ? structuredFacts(song, read, Promise.resolve(sure)) : Promise.resolve([] as string[])).then((list) => {
    const data = list.filter((f) => !recentFacts.includes(f) && !restatesRequest(f, song));
    if (!aiDone && onEarly && data.length) {
      early = toFacts(song, rankedData(data, dataRoom), (t) => structuredLabel.get(t));
      if (early.length) {
        console.log(`[FactGen] "${song.title}": ${early.length} facts from data go out while the AI writes`);
        remember(early.map((f) => f.text));
        onEarly(early);
      }
    }
    return data;
  });
  // And the article's own infobox: who wrote the song or made the game, when it came out.
  // Not for an edition the article's title doesn't name: "Some Game Royal" read from "Some Game" would get
  // the original's credits and year. The article still serves the captions.
  const edition = context ? editionNotInTitle(read.artist ?? "", page) : null;
  if (edition) console.log(`[Infobox] "${page}" doesn't name the edition "${edition}": no infobox facts`);
  const boxLookup: Promise<BoxFact[]> = context && !edition && !blockedArticles(song).has(STRUCTURED) ? infoboxFacts(page).then((list) => boxForRequest(list, page, song, read)) : Promise.resolve([]);

  const prompt = context ? groundedPrompt(read, context, want + OVERGENERATE) : unverifiedPrompt(song, want);
  let answer: string;
  try {
    answer = await askModel(prompt, songKey(asked));
  } catch (err) {
    aiDone = true;
    // The facts already on screen stand for the song when the AI fails (but not when the song changed).
    if (early.length && !(err instanceof Obsolete)) {
      console.warn(`[FactGen] The AI failed for "${song.title}": keeping the ${early.length} facts from data`);
      return { facts: early, ttlMs: RETRY_MS };
    }
    throw err;
  }
  aiDone = true;
  const lines = answer.split("\n").map((l) => l.trim()).filter(Boolean).filter((l) => {
    if (!context || !copiesExample(l, context)) return true;
    console.log("[Screen] DROP (copies an example)");
    return false;
  });
  const songFacts = await dataFacts;
  // A cover read from the original's article: who wrote it holds for the cover; the original's release, label and producers don't.
  const cover = context ? isCoverOf(page, articleText(page), read.artist ?? "", song.title) : false;
  const allBox = await boxLookup;
  const boxFacts = (cover ? allBox.filter((b) => /^(?:writers?|songwriters?|composer|lyricists?):/.test(b.evidence)) : allBox).filter(
    (b) => onStandard([b.text], [read.title, read.artist ?? ""]).length > 0
  );
  const { track } = resolveGameAndTrack(read);
  const cited = Boolean(context) && citesSentences();
  const { kept, rejected, sources: citedSentence } = screenClaims(lines, context, { otherParts: otherParts(context, track), track: aboutTheSong(read, context) ? undefined : track, cited, artists: artistNames(read.artist ?? "") });
  // A dropped caption is logged by its reason alone, never its words, so logs and the reports
  // made from them can't spread what was held back (issues #242 and #262).
  for (const r of rejected) console.log(`[Screen] DROP (${r.reason})`);
  // A caption from a "someone said" sentence offered only because the clean ones ran short must keep who said it.
  const attributed = kept.filter((f) => {
    if (!context || keepsAttribution(f, context)) return true;
    console.log("[Screen] DROP (drops who said it)");
    return false;
  });
  const unseen = attributed.filter((f) => !recentFacts.some((r) => tooSimilar(r, f)));
  if (unseen.length < attributed.length) console.log(`[Screen] DROP ${attributed.length - unseen.length} already shown for an earlier song`);
  // A limit the source sets ("in Japan", "the arcade version", "over", "usually") goes back in when the
  // model dropped it; a caption with no clear place for it is dropped.
  const repaired = new Map<string, string>();
  const fresh = unseen.filter((f) => {
    const scoped = context && scopeRepair.on ? repairScope(f, context) : f;
    const fixed = context && qualifierRepair.on ? repairQualifier(scoped, context) : { text: scoped };
    if ("drop" in fixed) {
      console.log(`[Screen] DROP (${fixed.drop})`);
      return false;
    }
    if (fixed.text !== f) console.log(`[Screen] SCOPE: ${f.slice(0, 70)} -> ${fixed.text.slice(0, 110)}`);
    repaired.set(f, fixed.text);
    return true;
  });
  // Music terms get a few fixed plain words, so any viewer can follow.
  const plain = new Map(fresh.map((f) => [f, explainMusicTerms(repaired.get(f) as string)]));
  // Data facts: the song's own first, then the infobox's; at most dataRoom, none a caption already
  // says. Facts sent early stay as sent, and the infobox only fills in after them.
  const candidates = [...(early.length ? [] : rankedData(songFacts, MAX_BUBBLES)).map((text) => ({ text, values: valuesIn(text), evidence: "" })), ...boxFacts];
  const structured: string[] = early.map((f) => f.text);
  for (const c of candidates) {
    if (structured.length >= dataRoom) break;
    if (recentFacts.includes(c.text) || restatesRequest(c.text, song)) continue;
    if (alreadySaid(c.values, [...fresh, ...structured])) continue;
    structured.push(c.text);
    if (c.evidence) {
      structuredLabel.set(c.text, `${SOURCE.infobox}${page}`);
      boxEvidence.set(c.text, c.evidence);
    }
  }
  // A spare takes the place of a line that only repeats the title and artist.
  const usable = fresh.filter((f) => !restatesRequest(plain.get(f) as string, song));
  const cites = new Map(usable.flatMap((f) => (citedSentence?.has(f) ? [[plain.get(f) as string, citedSentence.get(f) as string] as const] : [])));
  // Facts already sent stay first, as sent; the captions fill the bubbles left.
  const room = early.length ? Math.max(0, Math.min(want, MAX_BUBBLES) - early.length) : want;
  const sent = early.map((f) => f.text);
  const lead = structured.filter((f) => !sent.includes(f));
  const captions = context && config.sourceRisk ? rankedFromArticle(lead, usable, context, plain, citedSentence, room) : bestSupported(lead, usable, context, plain, citedSentence, room);
  const later = captions.filter((c) => !sent.includes(c));
  const shown = early.length ? [...sent, ...later] : captions;
  // Facts sent early were remembered when they went out.
  remember(early.length ? later : shown);
  console.log(`[Screen] "${song.title}": ${lines.length} generated, ${rejected.length} dropped, ${shown.length} shown`);

  if (shown.length) {
    record(asked, "grounded", shown.length);
    sources.set(songKey(asked), page);
    const article = `Wikipedia: ${page}`;
    return { facts: toFacts(song, shown, (t) => structuredLabel.get(t) ?? article, context, cites), ttlMs: Infinity };
  }
  if (sourcedOnly) return none;
  const fallback = entryFacts(entry, want);
  console.warn(`[FactGen] Nothing usable for "${song.title}", using ${fallback.length} entry and curated facts`);
  record(asked, "nothingSurvived", fallback.length);
  return { facts: toFacts(song, fallback, entrySource), ttlMs: RETRY_MS };
}

/**
 * The bubbles from an article (`rankFacts`): captions whose source sentence is risky to
 * retell are held back unless the song would show fewer than three, and the rest are
 * ordered by interest, data facts and lead captions first among equals, at most MAX_BUBBLES.
 */
function rankedFromArticle(
  data: string[],
  captions: string[],
  context: string,
  plain: ReadonlyMap<string, string>,
  cited: ReadonlyMap<string, string> | undefined,
  want: number
): string[] {
  const full = articleText(context.split("\n")[0]);
  const candidates: Candidate[] = [
    ...data.map((text) => ({ text, kind: "data" as const })),
    ...captions.map((f) => {
      const sentence = cited?.get(f) ?? supportingSentence(f, context, Infinity);
      return { text: plain.get(f) as string, kind: "caption" as const, sentence, lead: isLeadSentence(sentence, context, full) };
    }),
  ];
  // Data facts here are about the song, and the article is its artist's or game's: they lead.
  return rankFacts(candidates, { max: Math.min(want, MAX_BUBBLES), dataFirst: true, log: (line) => console.log(line) }).map((c) => c.text);
}

/**
 * SOURCE_RISK=off, or no reference (FACT_VERIFICATION=off): data facts first, then the
 * captions their source sentence supports best, in the order written.
 */
function bestSupported(
  data: string[],
  captions: string[],
  context: string,
  plain: ReadonlyMap<string, string>,
  cited: ReadonlyMap<string, string> | undefined,
  want: number
): string[] {
  const room = Math.max(0, want - data.length);
  const best = new Set(
    captions
      .map((f, i) => ({ f, i, score: context ? support(f, context, cited?.get(f)) : 0 }))
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, room)
      .map((x) => x.f)
  );
  return [...data, ...captions.filter((f) => best.has(f)).map((f) => plain.get(f) as string)].slice(0, want);
}

/**
 * The song with its artist's note in brackets left out (`withoutArtistNote`), and a note naming
 * who asked or paid for it left out of the title too (`withoutRequestCredit`): the same object
 * when it has neither.
 */
export function withoutNote(song: SSLSong): SSLSong {
  const artist = withoutArtistNote(song.artist ?? "");
  const title = withoutRequestCredit(song.title) || song.title;
  return artist === (song.artist ?? "").trim() && title === song.title ? song : { ...song, title, artist };
}

/**
 * A song's facts, by the first step that has any: the streamer's own facts for it, a live
 * learn's, an original's, then facts from a reference (`groundedFacts`).
 * `sourcedOnly`: facts from a source or none; never song-list or custom facts (a live learn's look-up).
 * `asked`: the request this is for, when `song` is a reading of it ("Artist - Title (Official Video)"
 * looked up as its title and artist). The model's work and the outcome belong to the request: under
 * the reading's name the built-in model took it for a song no longer playing and refused.
 */
async function generateRest(listed: SSLSong, entry: SSLQueueItem | null, want: number, sourcedOnly = false, asked: SSLSong = listed, onEarly?: EarlyFacts): Promise<Generated> {
  // Matched as listed: a note in brackets may be how the streamer wrote an alias.
  const own = ownSongFacts(listed, want, asked);
  if (own) return own;
  // From here on the artist is without its note ("Some Band (note)" is "Some Band"): a note is
  // never searched, sent to the AI, put in a fact or logged (issue #262).
  const song = withoutNote(listed);
  if (song.liveLearn) return liveLearnFacts(song, want, asked);
  const byTitle = await titleOnlyReading(song);
  if (byTitle) return generateRest(byTitle, entry, want, sourcedOnly, asked);
  const none = { facts: [] as Fact[], ttlMs: RETRY_MS };

  try {
    return originalFacts(song, entry, want, asked) ?? (await groundedFacts(song, entry, want, sourcedOnly, asked, onEarly));
  } catch (err) {
    if (err instanceof Obsolete) {
      // Not cached: the song may come back, and then it deserves a real try.
      console.log(`[FactGen] Dropped "${song.title}": the song changed before its facts were written`);
      return { facts: [], ttlMs: 0 };
    }
    if (sourcedOnly) return none;
    const fallback = entryFacts(entry, want);
    console.error(`[FactGen] Generation failed for "${song.title}":`, err);
    record(asked, "generationFailed", fallback.length);
    return { facts: toFacts(song, fallback, entrySource), ttlMs: RETRY_MS };
  }
}

/**
 * "No facts for this song" or "No facts for this artist" (issue #262): the streamer's own
 * facts only, their facts for this song and their custom facts tagged for it, its artist or
 * its game. Nothing is looked up and the AI writes nothing; no song-list or untagged custom
 * facts either. Null when neither switch is on. Logged by the song's title alone.
 */
export function ownFactsOnly(song: SSLSong): Fact[] | null {
  const off = factsOff(song);
  if (!off.song && !off.artist) return null;
  const want = config.factsPerSong;
  const theirs = findSongFacts(song);
  const mine = theirs && hasOwnFacts(theirs) ? songFactLines(theirs, want) : [];
  const tagged = taggedFor(song);
  const custom = [...tagged.forSong, ...takeTurns(tagged.pool, Math.max(0, want - mine.length - tagged.forSong.length))]
    .filter((t) => !mine.includes(t))
    .slice(0, Math.max(0, want - mine.length));
  console.log(`[FactGen] "${song.title}": facts are off for this ${off.song ? "song" : "artist"}, so only the streamer's own (${mine.length + custom.length})`);
  record(song, "factsOff", mine.length + custom.length);
  return toFacts(song, [...mine, ...custom], (t) => (mine.includes(t) ? SOURCE.yours : SOURCE.custom));
}

/** What may still show for a song after its switches changed: everything, or only the streamer's own facts. */
export function allowedFacts(song: SSLSong, facts: Fact[]): Fact[] {
  const off = factsOff(song);
  return off.song || off.artist ? facts.filter((f) => WRITTEN_BY_STREAMER.has(f.source)) : facts;
}

/**
 * Facts for a song. Results are cached, and concurrent callers (several
 * overlays, a reconnect mid-generation) share one generation.
 */
export function generateFacts(song: SSLSong, entry: SSLQueueItem | null = null, onEarly?: EarlyFacts): Promise<Fact[]> {
  // Checked before the cache, so a switch turned on applies at once, and off again brings the found facts back.
  const own = ownFactsOnly(song);
  if (own) return Promise.resolve(own);
  const key = songKey(song);
  const cached = factCache.get(key);
  if (cached && Date.now() < cached.expires) {
    factStats.cacheHits++;
    return Promise.resolve(cached.facts);
  }
  const revisionAtStart = revisions.get(key) ?? 0;
  let pending = inFlight.get(key);
  if (!pending) {
    pending = generate(song, entry, onEarly)
      .then(({ facts, ttlMs }) => {
        // A generation started before the song's facts changed may not overwrite them.
        if ((revisions.get(key) ?? 0) === revisionAtStart) factCache.set(key, { facts, expires: Date.now() + ttlMs });
        return facts;
      })
      .finally(() => {
        if (inFlight.get(key) === pending) inFlight.delete(key);
      });
    inFlight.set(key, pending);
  }
  // Superseded while it ran (the streamer saved facts for this song): start over.
  return pending.then((facts) => ((revisions.get(key) ?? 0) === revisionAtStart ? facts : generateFacts(song, entry, onEarly)));
}

/**
 * Facts from data that are ready while the AI still writes (issue #256): the first of the
 * song's facts, sent to the overlay at once. The full list `generateFacts` returns later
 * starts with them, unchanged, with the AI's captions after.
 */
export type EarlyFacts = (facts: Fact[]) => void;

/** Bumped when a song's facts change; a generation from an older revision is discarded. */
const revisions = new Map<string, number>();

/**
 * Forget every song's facts and what was shown. Only the tests call this, between cases; the app
 * never resets mid-session. It deliberately leaves three things alone. `outcomes`: a song's next
 * lookup records its own again, and until then the last one is still the true answer
 * for /recent. `structuredLabel`: it says which database a sentence came from, which doesn't
 * change, and it's set again each time the sentence is looked up. The Wrong blocks
 * (wrong-facts.ts): the streamer's own decisions, saved to disk; only Undo lifts one.
 */
export function clearFactCache(): void {
  factCache.clear();
  recentFacts.length = 0;
  poolTurns.clear();
  inFlight.clear();
  sources.clear();
  structuredShown.clear();
}

/** The songs a block is saved under: the request, and for a live learn or a title alone also the song it was looked up as. */
function blockedAs(song: SSLSong): SSLSong[] {
  const byTitle = song.titleOnly ? cachedArtistByTitle(song.title) : "";
  const lookup = song.liveLearn ? liveLearnLookup(song) : byTitle ? { ...song, artist: byTitle, titleOnly: undefined } : null;
  return lookup ? [song, lookup] : [song];
}

/**
 * What a fact's own source label says to block: an article, Wikidata and
 * MusicBrainz, or nothing (the streamer's own facts and song-list facts).
 * Undefined when there's no label to go by.
 */
export function blockFor(label: string | undefined): string | null | undefined {
  if (!label) return undefined;
  if (label.startsWith("Wikipedia: ")) return label.slice("Wikipedia: ".length);
  // A wrong infobox fact most often means the wrong article: the article is blocked.
  if (label.startsWith(SOURCE.infobox)) return label.slice(SOURCE.infobox.length);
  if (label === SOURCE.wikidata || label === SOURCE.musicbrainz) return STRUCTURED;
  return null;
}

/**
 * The bubbles Wrong takes off the song on now (issue #262): the one marked, and every other
 * one this play from the source it blocks (the same article, or Wikidata and MusicBrainz),
 * since a wrong fact usually means a wrong source. The streamer's own facts and song-list
 * facts block nothing, so only the one marked comes off.
 */
export function pulledWithWrong(facts: Fact[], fact: Fact): Fact[] {
  const source = blockFor(fact.source);
  return facts.filter((f) => f.text === fact.text || (!!source && blockFor(f.source) === source));
}

/**
 * Whose fact this is, by its label: one the streamer wrote for this song
 * ("song"), one of their custom facts ("custom"), or neither (null). Wrong
 * can't block the streamer's own facts, so the app offers to edit them instead.
 */
export function ownFactKind(label: string | undefined): "song" | "custom" | null {
  return label === SOURCE.yours ? "song" : label === SOURCE.custom ? "custom" : null;
}

/**
 * The streamer marked one of a song's facts wrong. Its source is blocked for
 * that song: decided by the fact's own label when it has one, so it's right
 * after a restart and for a song that already ended, and Wrong on the
 * streamer's own fact never blocks the article shown beside it. The blocked
 * source is the Wikipedia article, or Wikidata and MusicBrainz when the fact
 * came from them. The song's cached facts are dropped and forgotten as
 * "already shown", so the next time it plays BubbleFacts looks again.
 * Returns what was blocked, or null for custom, song-list or the streamer's own song facts.
 */
export function markWrong(song: SSLSong, text: string, label?: string): string | null {
  const key = songKey(song);
  const fromLabel = blockFor(label);
  const source = fromLabel !== undefined ? fromLabel : structuredShown.get(key)?.has(text) ? STRUCTURED : (sources.get(key) ?? null);
  if (source) for (const s of blockedAs(song)) blockArticle(s, source);
  const dropped = new Set((factCache.get(key)?.facts ?? []).map((f) => f.text));
  for (let i = recentFacts.length - 1; i >= 0; i--) if (dropped.has(recentFacts[i])) recentFacts.splice(i, 1);
  factCache.delete(key);
  sources.delete(key);
  structuredShown.delete(key);
  if (!ownFactKind(label)) logWrong(song, text, label, source); // a private test case for scripts/wrong-cases.mjs
  console.log(`[WrongFact] "${song.title}": ${source ? `won't use ${source === STRUCTURED ? source : `"${source}"`} again` : "not from a lookup"}`);
  return source;
}

/**
 * Writes captions for a made-up song from a fixed reference and screens
 * them, as a real song would be. The packaged-app smoke test runs two at once
 * to check the built-in model, the screening and the turn-taking queue
 * together (review: loading the model alone proved too little).
 */
export async function selfTest(variant = 0): Promise<{ generated: number; kept: string[]; ms: number }> {
  const started = Date.now();
  const title = variant ? "Starfall Nocturne" : "Starfall Overture";
  const context = `${title}\n${title} is a 2019 piece of video game music composed by Mia Chen for the game Starfall. ` +
    "It was recorded with a string quartet in Lisbon. The game was directed by John Smith and released for the Nintendo Switch.";
  const song: SSLSong = { title, artist: "Starfall" };
  const lines = (await askModel(groundedPrompt(song, context, 4))).split("\n").map((l) => l.trim()).filter(Boolean);
  const { kept } = screenClaims(lines, context, { cited: citesSentences() });
  return { generated: lines.length, kept, ms: Date.now() - started };
}

/** Forget a song's cached facts, so its next generation starts over (after its own facts change). */
export function forgetSong(song: SSLSong): void {
  const key = songKey(song);
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
  factCache.delete(key);
  inFlight.delete(key);
  // Its old sources too: Wrong on the new facts must not block an article from before.
  sources.delete(key);
  structuredShown.delete(key);
}

/** Undo "Wrong": the source may be used for the song again. */
export function unmarkWrong(song: SSLSong, source: string): void {
  for (const s of blockedAs(song)) unblockArticle(s, source);
  console.log(`[WrongFact] "${song.title}": "${source}" allowed again`);
}

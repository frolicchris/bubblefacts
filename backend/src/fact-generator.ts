import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { config } from "./config";
import { Fact, SSLQueueItem, SSLSong } from "./types";
import { articleMisfit, articleText, artistNames, companionOf, companionPages, curatedFacts, resetCuratedTurns, dropVersionTags, editionNotInTitle, explainMusicTerms, fetchGrounding, settledRevision, isCoverOf, isPerformerArticle, isPlaceholderRequest, keepsAttribution, mentionsName, notForStream, namesLoosely, normalizeTitle, numberedReference, otherParts, qualifierRepair, repairQualifier, repairScope, resolveGameAndTrack, restatesRequest, scopeRepair, screenClaims, splitGameAndTrack, summaryGate, support, supportingSentence, tooSimilar, workMatchConfidence, pageSummary, withSearches } from "./fact-verifier";
import { Candidate, MAX_BUBBLES, isLeadSentence, rankFacts } from "./fact-ranking";
import { isNotMusic } from "./not-music";
import { hasNoArtist, withoutArtistNote, withoutRequestCredit } from "./text";
import { buildStatFacts, isOriginal, isOwnOriginal } from "./stat-facts";
import { parseVideoTitle } from "./youtube-title";
import { readings } from "./list-profile";
import { topic } from "./topic";
import { artistByTitle, cachedArtistByTitle, musicbrainzFacts, statedYear, statesAlbum, withoutYear } from "./musicbrainz";
import { standardBreach } from "./content-standard";
import { articleItem, artistFacts, songItemFacts, wikidataFacts } from "./wikidata";
import { artistGoodFacts, clearArtistGoodCache } from "./artist-good";
import { loadedCaption, NEUTRAL_PROMPT } from "./neutral-wording";
import { alreadySaid, BoxFact, boxMisfit, clearInfoboxCache, infoboxFacts, PLATFORM_TAG, valuesIn } from "./infobox";
import { factsOff, findSongFacts, hasOwnFacts, songFactLines, songIdentity } from "./song-facts";
import { setCapped } from "./capped-map";
import { blockArticle, blockedArticles, songKey, unblockArticle } from "./wrong-facts";
import { logWrong } from "./wrong-log";
import { busyThreads, cpuTimes, CpuWatch, CPU_SAMPLE_MS, othersCpuShare, Pace, PaceKeeper, paceLine, SHORT_CAPTIONS, shorterContext, wordsPerSecond } from "./pace";
import { ABOUT_CREDIT, aboutIsChannelTalk, canAskAbout, forgetAbouts, loginForArtist, twitchAbout } from "./twitch-about";
import { PrepContext, prepContext, preparing, watchLookupTrouble } from "./prep-context";
import { MatchResult, aboutAnotherWork, candidateProfile, dataFitsTarget, holdsForEveryVersion, matchLine, requestProfile, resolveWork } from "./work-resolver";
import { PreparedEntry, PreparedFact, PreparedOutcome, preparedStore } from "./prepared-facts";

// Song -> timed fact bubbles: the streamer's own, data facts, or AI captions retold from an article
// and screened. No article: data, a Twitch About, else entry facts + topic packs (ARCHITECTURE.md: The life of one song)

const OVERGENERATE = 3;          // spare captions; screening drops some
const MAX_TOKENS = 512;
const HOSTED_MAX_TOKENS = 2048;  // hosted reasoning models (Groq's gpt-oss) spend part on thinking

// Spots, % of 1920x1080, clear of a queue panel top-left, camera top-right, goals bottom-right, banner
// bottom-center. `left` = left edge, under ~66% so a 560px bubble fits
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
// From the bottom edge: any length sits low, never off screen
const lowSpots = (list: Array<[number, number]>) => list.map(([bottom, left]): Fact["position"] => ({ bottom: `${bottom}%`, left: `${left}%` }));

// Now Playing's top (obs-overlay.css): 60px + two 1.944vh lines at 1.35 + padding, border, gap
const BANNER_TOP = "64px + 9.5vh * var(--bf-scale, 1)";
const NOW_PLAYING_CLEARANCE = `calc(${BANNER_TOP})`;
const LOWEST_TOP = 30; // % from top; lower spots could grow into Now Playing (long fact, biggest size), so measured from the bottom

// BUBBLE_AREA, for a camera, keyboard or chat on the default spots. Same limits: `left` <= 66%, clear of the banner
const AREAS: Record<string, Array<Fact["position"]>> = {
  anywhere: POSITIONS,
  top: spots([[6, 6], [6, 37], [6, 66], [20, 20], [20, 52], [20, 6], [20, 66], [6, 22]]),
  // Lowest row's middle is Now Playing's: first bubbles keep to the sides
  bottom: lowSpots([[5, 4], [5, 66], [20, 35], [20, 4], [20, 66], [5, 35], [12, 20], [12, 50]]),
  left: spots([[8, 3], [40, 3], [24, 3], [56, 3], [70, 3], [16, 3], [48, 3], [64, 3]]),
  right: spots([[8, 66], [40, 66], [24, 66], [56, 66], [70, 66], [16, 66], [48, 66], [64, 66]]),
  // Fixed spots: a new bubble replaces the last. Right ones from the right edge, center ones neither, so any length stays put
  "top-left": [{ top: "6%", left: "3%" }],
  "top-center": [{ top: "6%" }],
  "top-right": [{ top: "6%", right: "3%" }],
  "bottom-left": [{ bottom: "5%", left: "3%" }],
  // Waits above Now Playing while it shows, like every bottom spot (positionsFor)
  "bottom-center": [{ bottom: "5%" }],
  "bottom-right": [{ bottom: "5%", right: "3%" }],
};

const pct = (v: string) => Number(v.replace("%", ""));

// Spot clear of Now Playing (nearly screen-wide, so by height): bottom spots sit on it, low top spots grow upward
function clearOfBanner(p: Fact["position"]): Fact["position"] {
  if (p.bottom) {
    const b = pct(p.bottom) - 5;
    return { ...p, bottom: b > 0 ? `calc(${BANNER_TOP} + ${b}%)` : NOW_PLAYING_CLEARANCE };
  }
  const t = pct(p.top ?? "0");
  if (t <= LOWEST_TOP) return p;
  const { top: _top, ...side } = p;
  // A bubble is ~10% tall: bottom edge stays about put
  return { ...side, bottom: `max(${100 - t - 10}%, ${NOW_PLAYING_CLEARANCE})` };
}

/** The area's spots in order of use. `banner`: Now Playing or LIVE LEARN shows, so no spot reaches it */
export const positionsFor = (area: string = config.bubbleArea, banner: boolean = config.nowPlaying): Array<Fact["position"]> => {
  const spots = AREAS[area] ?? POSITIONS;
  return banner ? spots.map(clearOfBanner) : spots;
};
/** Vertical safe area, % per edge, clear of phone apps' buttons and chat; mirrored in obs-overlay.css */
export const VERTICAL_SAFE = { top: 14, bottom: 38, left: 6, right: 12 } as const;

// Vertical Now Playing's top: chat line (39%) + up to three 3.2vw lines at 1.35 + padding, gap
const VERTICAL_NOW_PLAYING_CLEARANCE = "calc(39% + 20vw * var(--bf-vertical-scale, 1))";

// VERTICAL_AREA: one spot each (room for one bubble); no left or right, the overlay centers them
const VERTICAL_AREAS: Record<string, Array<Fact["position"]>> = {
  // below the apps' top bar, growing down
  top: [{ top: "15%" }],
  // on the chat line, growing up (face in the upper part)
  "above-chat": [{ bottom: "39%" }],
};

/** Vertical spots; "above-chat" waits above Now Playing while it shows */
export const verticalPositionsFor = (area: string = config.verticalArea, banner: boolean = config.nowPlaying): Array<Fact["position"]> =>
  area === "above-chat" && banner ? [{ bottom: VERTICAL_NOW_PLAYING_CLEARANCE }] : VERTICAL_AREAS[area] ?? VERTICAL_AREAS.top;
/** Whether a song opens with LIVE LEARN or NOW PLAYING (each can be off; none for a commercial or ident) */
export const showsBanner = (song: SSLSong) => (song.liveLearn ? config.liveLearnBanner : config.nowPlaying && !isNotMusic(song));
/** A song's spots, clear of its banner */
export const positionsForSong = (song: SSLSong) => positionsFor(config.bubbleArea, showsBanner(song));
/** Bubble `i`'s landscape and vertical spots */
export const spotsForSong = (song: SSLSong) => {
  const landscape = positionsForSong(song);
  const vertical = verticalPositionsFor(config.verticalArea, showsBanner(song));
  return (i: number): Pick<Fact, "position" | "vertical"> => ({ position: landscape[i % landscape.length], vertical: vertical[i % vertical.length] });
};

export type Outcome = "grounded" | "wikidata" | "musicbrainz" | "songFacts" | "twitchAbout" | "original" | "liveLearn" | "noReference" | "nothingSurvived" | "generationFailed" | "factsOff" | "notMusic";

/** Session counts, for /health */
export const factStats = {
  grounded: 0,
  wikidata: 0,
  musicbrainz: 0,
  songFacts: 0,
  twitchAbout: 0,
  original: 0,
  liveLearn: 0,
  noReference: 0,
  generationFailed: 0,
  nothingSurvived: 0,
  factsOff: 0,
  notMusic: 0,
  cacheHits: 0,
  lastDurationMs: 0,
  lastEndpoint: "",
  lastOutcome: "",
};

const RETRY_MS = 10 * 60 * 1000; // ms until a song with no usable facts is retried
const MAX_KEPT = 2000;           // songs (or facts) per session map; oldest go first, costing only a repeat lookup
const factCache = new Map<string, { facts: Fact[]; expires: number }>();
// Songs whose captions all failed the screen -> article + model; same ones would write the same again (#203)
const screenedOut = new Map<string, string>();
// Per model: another may do better (#296)
const screenedKey = (page: string, model: string) => `${page}\0${model}`;
/** Wikidata and MusicBrainz as one blocklist entry, beside article titles */
export const STRUCTURED = "Wikidata and MusicBrainz";
// Each song's Wikidata or MusicBrainz sentences, to trace a wrong fact
const structuredShown = new Map<string, Set<string>>();
// Which database each sentence came from, for the dashboard
const structuredLabel = new Map<string, string>();
// Each cached song's article, for Wrong
const sources = new Map<string, string>();
// Facts shown this session: one artist's songs share an article, and repeats look broken (#19)
const RECENT_KEPT = 80;
const recentFacts: string[] = [];
// The stream's, or while preparing, the prepared song's own (prep-context.ts)
const recentList = (): string[] => preparing()?.recent ?? recentFacts;
// Last pick of each artist or game fact: one game can cover hundreds of songs, so its facts take turns
const poolTurns = new Map<string, number>();
let poolTurn = 0;
const inFlight = new Map<string, Promise<Fact[]>>();
// "@janeplayskeys", "Jane (@janeplayskeys)"
const STREAMER_HANDLE = /(?:^|[\s(])@([A-Za-z0-9_]{3,25})\)?\s*$/;
const songsLog = () => path.join(config.logDir, "songs.log");
const SONGS_LOG_LABEL: Record<Outcome, string> = {
  grounded: "article",
  wikidata: "wikidata",
  musicbrainz: "musicbrainz",
  songFacts: "yours",
  twitchAbout: "twitch",
  original: "original",
  liveLearn: "livelearn",
  noReference: "curated",
  nothingSurvived: "curated",
  generationFailed: "curated",
  factsOff: "off",
  notMusic: "notmusic",
};

// Last outcome per song: "nothing reliable" vs "failed" on the dashboard
const outcomes = new Map<string, Outcome>();
export const outcomeFor = (song: SSLSong): string => outcomes.get(songKey(song)) ?? "";

// Songs the AI was asked about in running generations
const aiAsked = new Set<string>();
// ms of each song's latest AI generation (#314)
const aiTimes = new Map<string, number>();
/** This play's AI time in ms; null when the AI wrote nothing */
export const aiTimeFor = (song: SSLSong): number | null => aiTimes.get(songKey(song)) ?? null;

// Paces the built-in AI to the computer (#314, pace.ts); online AIs and Ollama aren't paced
let pacer = new PaceKeeper();
/** Tests only */
export function resetPace(): void {
  pacer = new PaceKeeper();
}
// Never while preparing: not on stream, so never late
const paced = () => config.aiProvider === "builtin" && !preparing();
// To time facts as viewers wait for them
let songStartedAt = 0;
// Built-in model: last speed, GPU, making room for the stream, threads
const builtinInfo: { wordsPerSecond: number | null; gpu: string | null; makingRoom: boolean; threads: number | null } = { wordsPerSecond: null, gpu: null, makingRoom: false, threads: null };
const cpuWatch = new CpuWatch();

/** /health's keeping-up report: the dashboard line and its measures */
export function paceReport() {
  const pace: Pace = paced() ? pacer.pace() : "full";
  const average = pacer.averageMs();
  return {
    line: paceLine(pace),
    pace,
    averageWaitMs: average === null ? null : Math.round(average),
    wordsPerSecond: builtinInfo.wordsPerSecond,
    gpu: builtinInfo.gpu,
    othersCpu: cpuWatch.latestShare === null ? null : Math.round(cpuWatch.latestShare * 100) / 100,
    freeMemoryMb: Math.round(os.freemem() / 1024 / 1024),
    makingRoom: builtinInfo.makingRoom,
    threads: builtinInfo.threads,
  };
}

// Logs pace changes with their measures, to read a slow stream afterwards
function logPace(before: Pace, waitedMs: number, missed: boolean): void {
  const after = pacer.pace();
  if (after === before) return;
  const r = paceReport();
  const wait = `${missed ? "ended after" : "facts after"} ${Math.round(waitedMs / 1000)}s`;
  const cpu = r.othersCpu === null ? "?" : `${Math.round(r.othersCpu * 100)}%`;
  console.log(`[Pace] ${before} -> ${after} (this song: ${wait}; ${r.wordsPerSecond ?? "?"} words/s on ${r.gpu ?? "?"}, other programs ${cpu} CPU, ${r.freeMemoryMb} MB free)`);
}

/** One songs.log line: time, title, artist (no bracket note, #262), outcome, count */
export function songsLogLine(song: SSLSong, outcome: Outcome, count: number, now = new Date()): string {
  const clean = (v: string) => (v ?? "").replace(/\s+/g, " ");
  return [now.toISOString(), clean(withoutRequestCredit(song.title)), clean(withoutArtistNote(song.artist ?? "")), SONGS_LOG_LABEL[outcome], count].join("\t") + "\n";
}

function record(song: SSLSong, outcome: Outcome, count: number): void {
  // Preparing: the outcome goes to the store, not the counts or songs.log
  const prep = preparing();
  if (prep) {
    prep.outcome = outcome;
    return;
  }
  factStats[outcome]++;
  factStats.lastOutcome = outcome;
  setCapped(outcomes, songKey(song), outcome, MAX_KEPT);
  if (process.env.NODE_ENV === "test") return;
  const line = songsLogLine(song, outcome, count);
  fs.mkdir(config.logDir, { recursive: true }, () => fs.appendFile(songsLog(), line, () => undefined));
}

/** Source labels, as the dashboard shows them */
export const SOURCE = {
  yours: "Your facts for this song",
  songList: "Your song list",
  custom: "Your custom facts",
  wikidata: "Wikidata",
  musicbrainz: "MusicBrainz",
  infobox: "Wikipedia infobox: ", // + article
  twitchAbout: "Twitch About: ",  // + channel name
} as const;

/** Most data facts (Wikidata, MusicBrainz, infobox) beside an article's captions */
export const MAX_DATA_FACTS = 2;
const MAX_ABOUT_FACTS = 2; // bubbles from a Twitch About
// Infobox field behind each infobox sentence, for the dashboard
const boxEvidence = new Map<string, string>();
// Facts on the good an artist did -> article ("" = Wikidata); free slots only
const artistSentences = new Map<string, string>();

// Go up as written; all else must tell viewers something new
const WRITTEN_BY_STREAMER: ReadonlySet<string | undefined> = new Set([SOURCE.yours, SOURCE.custom]);

function toFacts(
  song: SSLSong,
  lines: string[],
  sourceOf: (text: string) => string | undefined = () => undefined,
  // The captions' reference, shown as what each rests on
  context = "",
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
    // From the artist's article (maybe not the reference): its own evidence
    const artistPage = artistSentences.get(text);
    // Reference or a companion it quotes (#48): link to the caption's own
    const linked = source?.startsWith("Wikipedia: ") ? source.slice("Wikipedia: ".length) : "";
    const ofReference = Boolean(page) && (linked === page || (Boolean(linked) && companionPages(context).includes(linked)));
    const fromArticle = ofReference || fromBox || Boolean(artistPage);
    const evidence = artistPage ? text : fromBox ? (boxEvidence.get(text) ?? "") : fromArticle ? (cites.get(text) ?? supportingSentence(text, context)) : "";
    return {
      text,
      source,
      ...(fromArticle ? { url: `https://en.wikipedia.org/wiki/${encodeURIComponent((artistPage ?? (ofReference ? linked : page)).replace(/ /g, "_"))}` } : {}),
      ...(evidence ? { evidence } : {}),
      delaySeconds: i * config.factIntervalSeconds,
      durationSeconds: config.factDurationSeconds,
      ...spotFor(i),
    };
  });
}

// --- Prompts -----------------------------------------------------------

// " -> ': a viewer's title can't close the quotes and pose as instructions
function promptWork(song: SSLSong): { game: string; work: string } {
  const { game: g, track: t } = resolveGameAndTrack(song);
  const [game, track] = [g, t].map((s) => s.replace(/"/g, "'"));
  return { game, work: track && track !== game ? `"${track}" from ${game}` : `"${track || game}"` };
}

function subjectLine(song: SSLSong): { game: string; intro: string } {
  const { game, work } = promptWork(song);
  // Nothing about the streamer: an online AI gets song and article only (final QA #7)
  return {
    game,
    intro: `You are writing short trivia captions for a live music stream overlay. The song playing right now is ${work}.`,
  };
}

/** CITE_SENTENCES=on: captions cite their sentence ("4 | caption"). Off by default: a 3B model miscounts */
export const citesSentences = () => process.env.CITE_SENTENCES === "on" && process.env.PROMPT_STYLE !== "rules";

// CROSS: Context, Role, Objective, Source, Scope. PROMPT_STYLE=rules: groundedPrompt's list
function crossPrompt(song: SSLSong, context: string, want: number): string {
  const { game, work } = promptWork(song);
  const page = context.split("\n")[0];
  const rule = isPerformerArticle(page, articleText(page) || context) ? ARTIST_SONG_RULE + NEUTRAL_PROMPT : "";
  return (citesSentences() ? citingCrossPrompt(game, work, context, want) : plainCrossPrompt(game, work, context, want)) + rule;
}

function crossOpening(game: string, work: string, want: number): string {
  return `CONTEXT
A musician is playing ${work} live on a stream right now. Short captions about the song pop up on screen, one at a time, in small bubbles. The readers are the viewers in chat: music fans of every level, not experts.

ROLE
Act as a music trivia writer for live streams, who retells what a text says plainly and exactly.

OBJECTIVE
Write ${want} captions about ${game} or its music that chat would enjoy learning. In order of preference: what the people who made it said or did, who or what influenced it, how the music is built, and how it was received (charts, awards, sales). Do not add praise or opinions of your own.`;
}

// Shared by both CROSS prompts
const RETELL_RULES = `Every person, year, number and title you write must appear in it, spelled the same way.`;
const STATEMENT_RULES = `never join two statements, and never move a name or a detail from one statement into another. Keep the statement's subject as your subject. Use a word of cause, order or count (because, due to, after, first, originally, twice) or a number only when that statement has it. Keep each detail with what it belongs to: a date with the release it dates, "second single from her third album" whole, every chart a position is on. Keep the statement's verb: "resembles" is not "inspired by", and what someone "described as" is their view, so name them. Write that someone said, described or recalled something only when the text says that person did, and quote only the text's own words. Keep "may have", "reportedly" and the like, and never make a claim bigger than the text: "one of the first" is not "the first". Name the group, chart or person: never "the duo", "the quartet" or "this chart" alone. If the text does not say something, leave it out.`;
/** A 3B model's three commonest slips, as made-up examples (algo loop, 2026-10; ARCHITECTURE.md: The life of one song) */
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

// Three of these in a row prove nothing
const COMMON_WORDS = new Set("the of a an s are is was were to in on and it its that by for with as about lyrics album song band said wrote".split(" "));
const words = (text: string) => text.toLowerCase().replace(/(\d),(\d)/g, "$1$2").match(/[a-z0-9]+/g) ?? [];
const threeWords = (list: string[]) => list.slice(0, -2).map((w, i) => `${w} ${list[i + 1]} ${list[i + 2]}`);
// Every three-word run in the examples, not all common words
const EXAMPLE_WORDING = new Set(
  RETELL_EXAMPLES.split("\n")
    .filter((l) => /^(Text|Wrong|Right): /.test(l))
    .flatMap((l) => threeWords(words(l.replace(/^\w+: /, ""))))
    .filter((g) => g.split(" ").some((w) => !COMMON_WORDS.has(w)))
);

/** Three words in a row from an example that the reference lacks ("sound like a storm"); no other screen catches it */
export function copiesExample(caption: string, context: string): boolean {
  const source = ` ${words(context).join(" ")} `;
  return threeWords(words(caption)).some((g) => EXAMPLE_WORDING.has(g) && !source.includes(` ${g} `));
}
/** For an artist's article: a line on another of their songs must say so, or chat takes it for the one playing */
export const ARTIST_SONG_RULE = ` The text is about the artist, not only this song. When a statement is about a different song, album or hit, make the artist the subject of your caption and name that other work, like "Her breakthrough hit was 'TITLE'." with the real title from the text. Never write it as if it were about the song playing now.`;
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

// For a 3B model: source first, each rule a test it can apply to its own sentence
function groundedPrompt(song: SSLSong, context: string, want: number): string {
  // CROSS by default: in trials it kept the rules better, more reception facts (#48)
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

// --- Providers ---------------------------------------------------------

/** Same for every provider; without one, node-llama-cpp adds its own (ARCHITECTURE.md: The life of one song) */
export const SYSTEM_PROMPT =
  "You write short trivia captions for a live music stream. You use only the reference text you are given, and you follow the instructions exactly.";

let anthropic: import("@anthropic-ai/sdk").default | undefined;

async function askAnthropic(prompt: string): Promise<string> {
  if (!anthropic) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  const res = await anthropic.messages.create({
    model: config.anthropicModel,
    max_tokens: MAX_TOKENS,
    // No temperature: Anthropic's API (2026-10-21) rejects it
    system: SYSTEM_PROMPT,
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

const GROQ_FALLBACK_MODEL = "openai/gpt-oss-20b";

function isModelGone(err: unknown): boolean {
  return err instanceof Error && /returned (404|400):/.test(err.message) && /model_not_found|model_decommissioned|decommissioned|does not exist/i.test(err.message);
}

/** Any chat-completions AI; on Groq a retired hand-set model falls back once, not failing every song */
export async function askOpenAICompatible(prompt: string): Promise<string> {
  const send = async (model: string) => {
    const data = await postJSON<{ choices?: Array<{ message?: { content?: string } }> }>(
      `${config.openaiBaseUrl}/chat/completions`,
      {
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: config.temperature,
        max_tokens: HOSTED_MAX_TOKENS,
      },
      config.openaiTimeoutMs,
      { Authorization: `Bearer ${config.openaiApiKey}` }
    );
    return data.choices?.[0]?.message?.content ?? "";
  };
  try {
    return await send(config.openaiModel);
  } catch (err) {
    if (!isGroqUrl(config.openaiBaseUrl) || config.openaiModel === GROQ_FALLBACK_MODEL || !isModelGone(err)) throw err;
    console.warn(`Groq no longer has the model "${config.openaiModel}"; using ${GROQ_FALLBACK_MODEL} instead.`);
    return send(GROQ_FALLBACK_MODEL);
  }
}

// The host, not the name anywhere in the URL
function isGroqUrl(url: string): boolean {
  try {
    return new URL(url).hostname === "api.groq.com";
  } catch {
    return false;
  }
}

// Main host, then the fallback; returns text and the host that answered
async function askOllama(prompt: string): Promise<[string, string]> {
  const hosts = [config.ollamaBaseUrl, config.ollamaFallbackUrl].filter(Boolean);
  let lastError: unknown;
  for (const host of hosts) {
    try {
      const data = await postJSON<{ response: string }>(
        `${host}/api/generate`,
        {
          model: config.ollamaModel,
          system: SYSTEM_PROMPT,
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

// node-llama-cpp is ESM: tsc would turn a plain import() into a failing require()
const importModule = new Function("specifier", "return import(specifier)") as (s: string) => Promise<any>;

// Loaded once (takes seconds), one reusable chat session
type Loaded = { session: any; dispose?: () => Promise<void> };
let builtin: Promise<Loaded> | undefined;
// Prep model, when not the stream's (config.prepareModelPath)
let prepBuiltin: Promise<Loaded> | undefined;
let llamaRuntime: Promise<any> | undefined;

// On the one shared runtime. `stream`: sets builtinInfo and starts the CPU watch (#314); the prep model (#296) doesn't
async function loadModelFile(modelPath: string, stream: boolean): Promise<Loaded> {
  const { getLlama, LlamaChatSession } = await importModule("node-llama-cpp");
  // Shipped binaries only: never compile llama.cpp on a musician's computer
  const runtime = (llamaRuntime ??= getLlama({ build: "never", ...(config.llamaGpu === "off" ? { gpu: false } : {}) }));
  // Drop only a runtime that failed; a failed model load keeps it, so the CPU watch still governs both
  const llama = await runtime.catch((err: unknown) => {
    if (llamaRuntime === runtime) llamaRuntime = undefined;
    throw err;
  });
  const model = await llama.loadModel({ modelPath });
  const context = await model.createContext({ contextSize: 4096 });
  const session = new LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt: SYSTEM_PROMPT });
  console.log(`[FactGen] Built-in model loaded (${llama.gpu || "cpu"})`);
  if (stream) {
    builtinInfo.gpu = llama.gpu || "cpu";
    watchCpu(llama, context.idealThreads as number);
  }
  return {
    session,
    dispose: async () => {
      await context.dispose();
      await model.dispose();
    },
  };
}

function loadBuiltin(): Promise<Loaded> {
  builtin ??= loadModelFile(config.modelPath, true).catch((err) => {
    builtin = undefined; // next song retries
    throw err;
  });
  return builtin;
}

// Standard prepares while Larger AI is on stream (#296)
const usesPrepModel = () => Boolean(config.prepareModelPath) && config.prepareModelPath !== config.modelPath;

function loadPrepBuiltin(): Promise<Loaded> {
  if (!usesPrepModel()) return loadBuiltin();
  prepBuiltin ??= loadModelFile(config.prepareModelPath, false).catch((err) => {
    prepBuiltin = undefined;
    throw err;
  });
  return prepBuiltin;
}

/** Frees the prep-only model after its last turn. Never throws */
export async function releasePrepModel(): Promise<void> {
  const loaded = prepBuiltin;
  prepBuiltin = undefined;
  if (!loaded) return;
  await builtinQueue.catch(() => undefined);
  await loaded.then((l) => l.dispose?.()).catch(() => undefined);
}

/** The model preparing now, for the store; "" for no AI */
export function prepModelName(): string {
  if (config.aiProvider === "builtin") return path.basename((usesPrepModel() ? config.prepareModelPath : config.modelPath) ?? "");
  if (config.aiProvider === "anthropic") return `anthropic:${config.anthropicModel}`;
  if (config.aiProvider === "openai") return `openai:${config.openaiModel}`;
  if (config.aiProvider === "ollama") return `ollama:${config.ollamaModel}`;
  return "";
}

/** Same naming; it rewrites the prep model's songs, last (#296) */
export const streamModelName = (): string => (config.aiProvider === "builtin" ? path.basename(config.modelPath ?? "") : prepModelName());

let cpuTimer: NodeJS.Timeout | undefined;

// Fewer threads and low priority while other programs fill the CPU (#314; ARCHITECTURE.md: A slow or busy computer)
function watchCpu(llama: { maxThreads: number }, usualThreads: number): void {
  if (cpuTimer) return;
  const usualMax = llama.maxThreads;
  let priority: number | null = null;
  try {
    priority = os.getPriority();
  } catch {
    // unknown: left as is
  }
  let before = cpuTimes();
  let ownBefore = process.cpuUsage();
  cpuTimer = setInterval(() => {
    const after = cpuTimes();
    const own = process.cpuUsage(ownBefore);
    const share = othersCpuShare(before, after, (own.user + own.system) / 1000);
    before = after;
    ownBefore = process.cpuUsage();
    const busy = cpuWatch.read(share);
    if (busy === builtinInfo.makingRoom) return;
    builtinInfo.makingRoom = busy;
    builtinInfo.threads = busy ? busyThreads(usualThreads) : null;
    // From the next evaluation on; 0 (GPU default) = no limit
    llama.maxThreads = busy ? busyThreads(usualThreads) : usualMax;
    try {
      if (busy) os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
      else if (priority !== null) os.setPriority(priority);
    } catch {
      // Raising it back needs rights on Linux and macOS: stays low
    }
    console.log(
      busy
        ? `[Pace] Other programs use ${Math.round(share * 100)}% of the CPU: the AI uses ${busyThreads(usualThreads)} threads at low priority`
        : "[Pace] The CPU is calm again: the AI uses all its threads"
    );
  }, CPU_SAMPLE_MS);
  cpuTimer.unref();
}

type FakeSession = { prompt: (text: string, options: { signal: AbortSignal }) => Promise<string>; resetChatHistory: () => void };

/** Tests only: fake chat sessions for the stream and prep models */
export function useBuiltinSession(session: FakeSession, prepSession?: FakeSession): void {
  builtin = Promise.resolve({ session });
  prepBuiltin = prepSession ? Promise.resolve({ session: prepSession }) : undefined;
}

/** Loads at start-up: first song not slowed, failure shown at once. The desktop app watches both log lines */
export async function warmUpBuiltin(): Promise<void> {
  if (config.aiProvider !== "builtin") return;
  try {
    await loadBuiltin();
  } catch (err) {
    console.error(`[FactGen] Built-in model failed to load: ${err instanceof Error ? err.message : err}`);
  }
}

const BUILTIN_TIMEOUT_MS = 90_000; // ms per song before it's stopped
let builtinQueue: Promise<unknown> = Promise.resolve();

// Song off stream: its AI work is dropped
class Obsolete extends Error {}
// Set by the server; null when unknown (tests, self-test)
let currentKey: string | null = null;
let running: { key: string | null; stop: AbortController; prep: boolean } | null = null;

/** The song on stream; others' AI work stops, so quick skips build no backlog */
export function setCurrentSong(song: SSLSong | null): void {
  // Stream before prep: the prep turn gives way, prepared later
  if (song && running?.prep) running.stop.abort();
  const key = song ? songKey(song) : null;
  if (key !== currentKey) {
    // Ended while the AI wrote: too late (#314)
    if (paced() && currentKey && aiAsked.has(currentKey)) {
      const before = pacer.pace();
      pacer.missed(Date.now() - songStartedAt);
      logPace(before, Date.now() - songStartedAt, true);
    }
    songStartedAt = Date.now();
    if (key) pacer.songStarted();
  }
  currentKey = key;
  if (running?.key && running.key !== currentKey) {
    // A quick return to the song starts afresh, not joining this
    inFlight.delete(running.key);
    running.stop.abort();
  }
}
const obsolete = (key: string | null) => key !== null && currentKey !== null && key !== currentKey;

// One chat session, songs in turn (ARCHITECTURE.md); output cut off at the timeout is still screened
function askBuiltin(prompt: string, key: string | null = null): Promise<string> {
  // Preparing: stopping the run stops its turn; may use its own model
  const prep = preparing();
  const run = async () => {
    if (obsolete(key) || prep?.signal.aborted) throw new Obsolete();
    const { session } = await (prep && !prep.streamModel ? loadPrepBuiltin() : loadBuiltin());
    session.resetChatHistory();
    const stop = new AbortController();
    running = { key, stop, prep: Boolean(prep) };
    const writing = Date.now();
    try {
      const text = (await session.prompt(prompt, {
        temperature: config.temperature,
        maxTokens: MAX_TOKENS,
        signal: AbortSignal.any([AbortSignal.timeout(BUILTIN_TIMEOUT_MS), stop.signal, ...(prep ? [prep.signal] : [])]),
        stopOnAbortSignal: true,
      })) as string;
      if (stop.signal.aborted || prep?.signal.aborted) throw new Obsolete();
      // Stream model's speed only (#314)
      if (!prep) builtinInfo.wordsPerSecond = wordsPerSecond(text, Date.now() - writing) ?? builtinInfo.wordsPerSecond;
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
  if (key) aiAsked.add(key);
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
  const ms = Date.now() - started;
  // Preparing: kept out of /health and the dashboard
  if (preparing()) console.log(`[Prepare] ${endpoint} answered in ${(ms / 1000).toFixed(1)}s`);
  else {
    factStats.lastEndpoint = endpoint;
    factStats.lastDurationMs = ms;
    console.log(`[FactGen] ${endpoint} answered in ${(ms / 1000).toFixed(1)}s`);
  }
  return text;
}

// --- Pipeline ----------------------------------------------------------

// Wikidata, then MusicBrainz, unless marked wrong. Looks up `reading`; bookkeeping stays with `song`
async function structuredFacts(song: SSLSong, reading: SSLSong = song, sure: Promise<SureArticle | null> = Promise.resolve(null)): Promise<string[]> {
  if (blockedArticles(song).has(STRUCTURED)) return [];
  const names = [reading.title, reading.artist ?? ""];
  const data = onStandard(await wikidataFacts(reading), names);
  let facts = data;
  if (!data.length) {
    // Article's item beside MusicBrainz; with MusicBrainz facts, added only if already in (cached for next play)
    const item = sure.then((found) => (found ? articleItem(found.page, found.names, requestTitles(song, reading)) : null));
    const mb = await musicbrainzFacts(reading);
    const found = mb.length ? await Promise.race([item, Promise.resolve(null)]) : await item;
    const fromItem = found?.kind === "song" ? songItemFacts(found, { year: statedYear(mb), album: statesAlbum(mb) }) : { facts: found?.facts ?? [], dropYear: false };
    const fromMb = onStandard(fromItem.dropYear ? withoutYear(mb) : mb, names);
    const added = onStandard(fromItem.facts, [...names, found?.kind === "song" ? found.title : ""]).filter((f) => !fromMb.includes(f));
    for (const f of fromMb) setCapped(structuredLabel, f, SOURCE.musicbrainz, MAX_KEPT);
    for (const f of added) setCapped(structuredLabel, f, SOURCE.wikidata, MAX_KEPT);
    facts = [...fromMb, ...added];
  } else for (const f of data) setCapped(structuredLabel, f, SOURCE.wikidata, MAX_KEPT);
  // One good-the-artist-did fact for a sure article; looked up last, never crowding the song's
  const found = await sure;
  const good = found ? await artistGoodFacts(found.page, found.names) : [];
  const turn = good.find((f) => !blockedArticles(song).has(f.page) && !recentList().includes(f.text) && !facts.includes(f.text) && !restatesRequest(f.text, song));
  if (turn) {
    setCapped(structuredLabel, turn.text, turn.page ? `Wikipedia: ${turn.page}` : SOURCE.wikidata, MAX_KEPT);
    setCapped(artistSentences, turn.text, turn.page, MAX_KEPT);
    facts = [...facts, turn.text];
  }
  setCapped(structuredShown, songKey(song), new Set(facts), MAX_KEPT);
  return facts;
}

/** A sequel the title names before its track ("Super Rocket Drift II: Area 3" by "Rocket Drift": a series), or "" */
export function titleGame(title: string, game: string): string {
  const named = splitGameAndTrack(dropVersionTags(title)).game;
  const spaced = (s: string) => ` ${normalizeTitle(s)} `;
  return named !== title && normalizeTitle(named) !== normalizeTitle(game) && normalizeTitle(game) && spaced(named).includes(spaced(game)) ? named : "";
}

// As typed and as read, whole and without the game in front
function requestTitles(song: SSLSong, read: SSLSong): string[] {
  return [...new Set([song, read].flatMap((s) => [s.title, resolveGameAndTrack(s).track]).filter(Boolean))];
}

// None unless the infobox is the requested work's (boxMisfit); a game's asks MusicBrainz if the artist performs this song
async function boxForRequest(list: BoxFact[], page: string, song: SSLSong, read: SSLSong): Promise<BoxFact[]> {
  const about = list.find((b) => b.about)?.about;
  if (!about) return list;
  const { game } = resolveGameAndTrack(read);
  const titles = requestTitles(song, read);
  const performer = about.kind === "game" ? await musicbrainzFacts(read).then((mb) => Boolean(statedYear(mb) || statesAlbum(mb))) : false;
  const why = boxMisfit(about, { game, titles, gameTrack: PLATFORM_TAG.test(song.artist ?? "") }, performer);
  if (why) {
    console.log(`[Infobox] "${page}": ${why}, no infobox facts`);
    return [];
  }
  return list;
}

interface SureArticle {
  page: string;
  names: string[];
}

// For its Wikidata item (#256): the AI reference's checks; null if none or unsure. Never throws
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

// Data facts must meet the content standard too (#242); drops logged by reason. `names`: title, artist ("Smooth Criminal")
function onStandard(facts: string[], names: string[] = []): string[] {
  return facts.filter((f) => {
    const reason = standardBreach(f, names);
    if (reason) console.log(`[Screen] DROP data fact (${reason})`);
    return !reason;
  });
}

// Most interesting first, at most MAX_BUBBLES; SOURCE_RISK=off keeps them as found
function rankedData(data: string[], want: number): string[] {
  const max = Math.min(want, MAX_BUBBLES);
  const songs = data.filter((f) => !artistSentences.has(f));
  if (!config.sourceRisk) return [...songs, ...data.filter((f) => artistSentences.has(f))].slice(0, want);
  const free = songs.length < max ? data : songs;
  return rankFacts(free.map((text) => ({ text, kind: "data" as const })), { max }).map((c) => c.text);
}

/** Recent facts for the saved session; restoreRecent puts them back */
export const recentShown = (): string[] => [...recentFacts];
export function restoreRecent(list: string[]): void {
  recentFacts.length = 0;
  recentFacts.push(...list.slice(-RECENT_KEPT));
}
/** Facts sent before a restart stand: nothing is written again */
export function primeFacts(song: SSLSong, facts: Fact[]): void {
  setCapped(factCache, songKey(song), { facts, expires: Infinity }, MAX_KEPT);
}

function remember(shown: string[]): void {
  const list = recentList();
  list.push(...shown);
  list.splice(0, Math.max(0, list.length - RECENT_KEPT));
}

// Not its artist's or game's
function aboutTheSong(song: SSLSong, context: string): boolean {
  const { game, track } = resolveGameAndTrack(song);
  if (!track || track === game) return true;
  return mentionsName(normalizeTitle(context.split("\n")[0]), [normalizeTitle(track)]);
}

const MAX_MISFITS = 2; // articles skipped before giving up on a reading

// Skips misfits (articleMisfit) and searches again: "Jezebel" by Sade finds the singer, not the queen
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

/** The reference ("" for none) and the reading that found it; readings tried in turn */
export async function findReference(song: SSLSong): Promise<{ context: string; read: SSLSong }> {
  let context = "";
  let read = song;
  for (const reading of readings(song)) {
    const found = await fittingGrounding(song, reading);
    if (!found) continue;
    // Artist's article is the weakest find: kept, but later readings may do better
    const onlyTheArtist = artistNames(reading.artist ?? "").includes(normalizeTitle(found.split("\n")[0]));
    if (context && onlyTheArtist) continue;
    context = found;
    read = reading;
    if (!onlyTheArtist) break;
  }
  return { context, read };
}

// Queue entry facts, topped up from the topic packs; true by construction
function entryFacts(entry: SSLQueueItem | null, want: number): string[] {
  const stats = buildStatFacts(entry, { streamerName: config.sslStreamerName }).slice(0, want);
  for (const s of stats) statLines.add(s);
  // Not while preparing: custom facts show live, so no turn taken from the rotation (#190)
  return [...stats, ...(preparing() ? [] : curatedFacts(want - stats.length))];
}

// Song-list lines, told apart from custom facts on the dashboard
const statLines = new Set<string>();
const entrySource = (t: string) => (statLines.has(t) ? SOURCE.songList : SOURCE.custom);

/** Custom facts tagged with title, artist or game ("[Chopin] ..."); a version tag fits only that version */
export function taggedFactsFor(song: SSLSong): string[] {
  const { forSong, pool } = taggedFor(song);
  return [...forSong, ...pool];
}

// `forSong`: tagged for this song; `pool`: for its artist or game, shared by all their songs
function taggedFor(song: SSLSong): { forSong: string[]; pool: string[] } {
  if (!topic.taggedFacts?.length) return { forSong: [], pool: [] };
  const { game, track } = resolveGameAndTrack(song);
  const named = (list: (string | undefined)[]) => new Set(list.map((s) => normalizeTitle(s ?? "")).filter(Boolean));
  const titles = named([song.title, track, `${song.artist} ${song.title}`]);
  const shared = named([game, ...artistNames(song.artist ?? "")]);
  // Peel trailing brackets: "X (Acoustic) [Instrumental]" is also "X (Acoustic)", never "X (Remix)"
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

// Longest unused first, then as written
function takeTurns(pool: string[], n: number): string[] {
  const picked = pool
    .map((text, i) => ({ text, i, turn: poolTurns.get(text) ?? -1 }))
    .sort((a, b) => a.turn - b.turn || a.i - b.i)
    .slice(0, n)
    .map((p) => p.text);
  // Preparing shows none: takes no turn
  if (!preparing()) for (const text of picked) setCapped(poolTurns, text, ++poolTurn, MAX_KEPT);
  return picked;
}

// Not the streamer's or the song list's
const fromASource = (f: Fact) => !WRITTEN_BY_STREAMER.has(f.source) && f.source !== SOURCE.songList;

// Tagged facts first; pool facts take turns (one beside sourced facts, else every bubble); then the rest
async function generate(song: SSLSong, entry: SSLQueueItem | null, onEarly?: EarlyFacts): Promise<{ facts: Fact[]; ttlMs: number }> {
  const want = config.factsPerSong;
  // Own song facts take their pool fact in generateRest
  const tagged = findSongFacts(song) ? { forSong: [], pool: [] } : taggedFor(song);
  const mine = tagged.forSong.slice(0, want);
  // Mixed with tagged facts: re-spaced at the end, sent once
  if (!mine.length && !tagged.pool.length) return generateRest(song, entry, want, false, song, onEarly);
  const room = want - mine.length;
  const rest = room > 0 ? await generateRest(song, entry, room) : { facts: [], ttlMs: Infinity };
  const found = rest.facts.filter((f) => !mine.includes(f.text) && !tagged.pool.includes(f.text));
  const known = found.some(fromASource);
  const pool = room > 0 ? takeTurns(tagged.pool, known ? 1 : room) : [];
  const others = found.slice(0, room - pool.length);
  console.log(`[FactGen] "${song.title}": ${mine.length + pool.length} of the streamer's own facts are for this song`);
  // First bubble about the song: its tagged facts, else the first sourced fact
  const first = mine.length ? undefined : others.find(fromASource);
  const lead = first ? [first.text] : mine;
  const lines = [...lead, ...pool, ...others.map((f) => f.text).filter((t) => !lead.includes(t))];
  // Labeled custom: where the streamer edits them
  const theirs = new Set([...mine, ...pool]);
  const sourceOf = (t: string) => (theirs.has(t) ? SOURCE.custom : others.find((f) => f.text === t)?.source);
  // Re-spacing rebuilds facts: carry link and evidence over
  const sourced = new Map(others.map((f) => [f.text, f]));
  const facts = toFacts(song, lines, sourceOf).map((f) => {
    const was = sourced.get(f.text);
    return was ? { ...f, ...(was.url ? { url: was.url } : {}), ...(was.evidence ? { evidence: was.evidence } : {}), ...(was.via ? { via: was.via } : {}) } : f;
  });
  return { facts, ttlMs: rest.ttlMs };
}

/** A live learn's lookup: as typed, or with no artist, read as a YouTube title. Null with no artist: bare titles mismatch */
export function liveLearnLookup(song: SSLSong): SSLSong | null {
  const artist = (song.artist ?? "").trim();
  if (artist && !hasNoArtist(artist)) return { title: song.title, artist };
  const parsed = parseVideoTitle(song.title);
  if (!parsed.artist || !parsed.title) return null;
  return { title: parsed.title, artist: parsed.artist, ...(parsed.performer ? { performer: true } : {}), ...(parsed.confident ? {} : { artistUncertain: true }) };
}

// No artist: MusicBrainz's only artist with this exact title, data facts only; else null
async function titleOnlyReading(song: SSLSong): Promise<SSLSong | null> {
  if (!song.titleOnly || !config.factVerification) return null;
  const artist = await artistByTitle(song.title);
  if (!artist) return null;
  console.log(`[FactGen] "${song.title}" has no artist: looked up as by ${artist}, the only artist with this title`);
  return { ...song, artist, titleOnly: undefined, artistFromTitle: true };
}

// ttlMs 0: not cached; Infinity: for the session
type Generated = { facts: Fact[]; ttlMs: number };

// The streamer's facts for this song, as written, no lookup; even a live learn (often another creator's original)
function ownSongFacts(song: SSLSong, want: number, asked: SSLSong): Generated | null {
  const ownRecord = findSongFacts(song);
  // A switch alone ("No facts for this song") isn't facts
  if (!ownRecord || !hasOwnFacts(ownRecord)) return null;
  const lines = songFactLines(ownRecord, want);
  // Room left: one pool fact, before the creator's link
  const pool = lines.length < want ? takeTurns(taggedFor(song).pool, 1) : [];
  lines.splice(ownRecord.link?.trim() ? lines.length - 1 : lines.length, 0, ...pool);
  console.log(`[FactGen] "${song.title}": ${lines.length} of the streamer's own facts for this song`);
  record(asked, "songFacts", lines.length);
  // Not cached: edits apply next play
  return { facts: toFacts(song, lines, (t) => (pool.includes(t) ? SOURCE.custom : SOURCE.yours)), ttlMs: 0 };
}

// Sourced facts or none; the banner shows either way
async function liveLearnFacts(song: SSLSong, want: number, asked: SSLSong): Promise<Generated> {
  // A well-known song gets facts too (#45); never filler
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

// Artist named exactly like a Twitch channel: a line or two of its About. Null on any doubt; never throws
async function twitchAboutFacts(song: SSLSong, want: number, asked: SSLSong): Promise<Generated | null> {
  // Never on a guessed artist
  const login = song.artistFromTitle || song.artistUncertain ? "" : loginForArtist(song.artist ?? "");
  if (!login || taggedFactsFor(song).length) return null;
  try {
    // No AI: the article hasn't been sought yet; a song with one never gets an About
    if (config.aiProvider === "none" && (await findReference(song)).context) return null;
    const about = await twitchAbout(login);
    if (!about) return null;
    const label = `${SOURCE.twitchAbout}${about.name}`;
    if (blockedArticles(song).has(label)) return null;
    const names = [song.title, song.artist ?? ""];
    const fit = onStandard(about.facts, names).filter((f) => !notForStream(f) && !aboutIsChannelTalk(f) && !loadedCaption(f, names, true));
    const shown = fit.map((f) => `${ABOUT_CREDIT}${f}`).filter((f) => !recentList().includes(f) && !restatesRequest(f, song)).slice(0, Math.min(want, MAX_ABOUT_FACTS));
    if (!shown.length) return null;
    console.log(`[FactGen] "${song.title}": ${shown.length} from the Twitch About of the channel named like its artist`);
    remember(shown);
    record(asked, "twitchAbout", shown.length);
    return { facts: toFacts(song, shown, () => label), ttlMs: Infinity };
  } catch (err) {
    console.warn(`[FactGen] Twitch About skipped for "${song.title}": ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** Twitch About off or Twitch disconnected: songs that had one look again */
export function forgetTwitchAbout(): void {
  forgetAbouts();
  for (const [key, cached] of factCache) if (cached.facts.some((f) => f.source?.startsWith(SOURCE.twitchAbout))) factCache.delete(key);
}

// Another artist's "Originals" song with no article: its Twitch About before its entry facts
async function friendsOriginalAbout(song: SSLSong, entry: SSLQueueItem | null, want: number, asked: SSLSong): Promise<Generated | null> {
  const names = [config.sslStreamerName, config.streamerDisplayName];
  if (!canAskAbout() || !config.originals || !isOriginal(entry, names) || isOwnOriginal(entry, names)) return null;
  return (await findReference(song)).context ? null : twitchAboutFacts(song, want, asked);
}

// Entry facts and the streamer's notes, no lookup; null if not an original
function originalFacts(song: SSLSong, entry: SSLQueueItem | null, want: number, asked: SSLSong): Generated | null {
  const names = [config.sslStreamerName, config.streamerDisplayName];
  if (!(config.originals && isOriginal(entry, names))) return null;
  const stats = buildStatFacts(entry, { streamerName: config.sslStreamerName, isOriginalSong: true, names });
  // Notes only for their own pieces, two at random first, so the same ones don't open every original
  const notes = isOwnOriginal(entry, names) ? [...topic.originalsFacts].sort(() => Math.random() - 0.5) : [];
  const statSet = new Set(stats);
  const lines = [...notes.slice(0, 2), ...stats, ...notes.slice(2)];
  const facts = toFacts(song, lines, (t) => (statSet.has(t) ? SOURCE.songList : SOURCE.custom)).slice(0, want);
  console.log(`[FactGen] "${song.title}" is an original: ${facts.length} facts from the song entry`);
  record(asked, "original", facts.length);
  // Not cached: requester and play count change; free to rebuild
  return { facts, ttlMs: 0 };
}

// For the scored match when the article is cached
const searchesFor = new Map<string, string[][]>();

// work-resolver.ts on what the lookup already read; unreadable = unknown. Never throws
async function scoreMatch(song: SSLSong, read: SSLSong, context: string): Promise<MatchResult> {
  const page = context.split("\n")[0];
  const summary = await pageSummary(page).catch(() => null);
  const mb = await musicbrainzFacts(read);
  const credited = statedYear(mb) || statesAlbum(mb) ? true : null;
  const searches = searchesFor.get(songKey(song)) ?? [];
  const rank = searches.some((s) => s[0] === page) ? 0 : -1;
  const pick = candidateProfile(page, articleText(page) || context.slice(page.length + 1), summary?.description ?? "", rank);
  const others = [...new Set(searches.flat())].filter((t) => t !== page).map((t) => candidateProfile(t));
  return resolveWork(requestProfile(song, read, credited), pick, others);
}

// Article captions, screened; data facts if no article or unsure; else entry facts (unless `sourcedOnly`)
async function groundedFacts(song: SSLSong, entry: SSLQueueItem | null, want: number, sourcedOnly: boolean, asked: SSLSong, onEarly?: EarlyFacts): Promise<Generated> {
  // Prepared by this same function (#293): shown at once after re-checks
  const ready = preparedFacts(song, asked, want);
  if (ready) return ready;
  const none = { facts: [] as Fact[], ttlMs: RETRY_MS };
  // Lists differ ("Game - Track", "Track (Film)"); `read` is the reading that found the article
  let context = "";
  let read = song;
  // Another music content creator's piece: no encyclopedia knows it
  const handle = STREAMER_HANDLE.exec(song.artist ?? "")?.[1];
  if (handle) console.log(`[FactGen] "${song.title}" is credited to a streamer (@${handle}): not looked up`);
  // "Off-List YouTube Request < 5 Min (Free)": a queue slot; its "article" would be YouTube's
  const placeholder = isPlaceholderRequest(song);
  if (placeholder) console.log(`[FactGen] "${song.title}" is a request placeholder, not a song: not looked up`);
  if (config.aiProvider !== "none" && config.factVerification && !handle && !placeholder) {
    const { found, searches } = await withSearches(() => findReference(song));
    ({ context, read } = found);
    if (searches.length) setCapped(searchesFor, songKey(song), searches, MAX_KEPT);
    if (read !== song) console.log(`[FactGen] "${song.title}" read as "${read.title}" from ${read.artist}`);
  }
  // No AI, no article or FACT_VERIFICATION=off: data, else entry facts. Never AI without a reference
  if (config.aiProvider === "none" || !config.factVerification || !context) {
    const lookup = config.factVerification && !handle && !placeholder;
    // No AI: a sure article's Wikidata item still adds facts (#256)
    const sure = lookup && config.aiProvider === "none" ? sureArticle(song) : Promise.resolve(null);
    // Wikidata, then MusicBrainz, no AI (#23)
    const data = lookup ? await structuredFacts(song, read, sure) : [];
    const shownData = rankedData(data.filter((f) => !recentList().includes(f) && !restatesRequest(f, song)), want);
    if (shownData.length) {
      remember(shownData);
      record(asked, structuredLabel.get(shownData[0]) === SOURCE.musicbrainz ? "musicbrainz" : "wikidata", shownData.length);
      return { facts: toFacts(song, shownData, (t) => structuredLabel.get(t)), ttlMs: Infinity };
    }
    // `data`, not `shownData`: facts shown before still mean the databases know the song
    const fromTwitch = lookup && !data.length ? await twitchAboutFacts(song, want, asked) : null;
    if (fromTwitch) return fromTwitch;
    if (sourcedOnly) return none;
    const lines = entryFacts(entry, want);
    console.log(`[FactGen] No reference for "${song.title}": using ${lines.length} entry and curated facts`);
    record(asked, "noReference", lines.length);
    // retried once the lookup's no-result cache expires
    return { facts: toFacts(song, lines, entrySource), ttlMs: RETRY_MS };
  }

  // Unsure it's this song's article (#255): data facts only. Wikipedia's summary can say so too (disambiguation, a film)
  let match = context && config.abstain ? workMatchConfidence(read, context, song) : null;
  // Artist found by title alone: data facts at most
  if (context && song.artistFromTitle && match?.level !== "unsure") match = { level: "unsure", reason: "the artist was found by the title alone" };
  if (match?.level === "sure") {
    const why = await summaryGate(read, context, song);
    if (why) match = { level: "unsure", reason: why };
  }
  // Scored match (#172): shadow logs; scored holds back, never adds
  const scored = context && config.match !== "rules" ? await scoreMatch(song, read, context) : null;
  if (scored) {
    console.log(matchLine(scored, song.title));
    const rules = match?.level === "unsure" ? "unsure" : "sure";
    if (config.match === "shadow" && (rules === "sure") !== (scored.decision === "sure")) console.log(`[Grounding] match differs: rules ${rules}, scored ${scored.decision} for "${song.title}"`);
  }
  // Score not sure: no captions, only data true of every version (who wrote it)
  const dataOnly = config.match === "scored" && Boolean(scored) && scored?.decision !== "sure";
  // Data fact fits the requested version (a year tag)
  const fitsTarget = (f: string) => config.match !== "scored" || !scored || dataFitsTarget(f, scored.request);
  if (match?.level === "unsure" || dataOnly) {
    const why = match?.level === "unsure" ? match.reason : scored?.decision === "abstain" ? `the article may be another work (${scored.top.points})` : "the scored match is not sure";
    console.log(`[Grounding] unsure: ${why} ("${context.split("\n")[0]}" for "${song.title}"), showing facts from data only`);
    const fresh = (list: string[]) => list.filter((f) => !recentList().includes(f) && !restatesRequest(f, song) && (!dataOnly || holdsForEveryVersion(f)) && fitsTarget(f));
    const data = fresh(await structuredFacts(song, read));
    // Too few: up to two Wikidata facts on its artist or game
    const { game } = resolveGameAndTrack(read);
    const page = context.split("\n")[0];
    // Series as artist, game in title: that game's facts, not the series' first
    const about = isPerformerArticle(page, articleText(page) || context) ? page : titleGame(read.title, game) || game;
    // MusicBrainz says the article is another act's: no artist facts
    const sameName = /^MusicBrainz credits /.test(match?.reason ?? "");
    const extra = !sameName && !dataOnly && data.length + taggedFor(song).pool.length < 2 ? fresh(onStandard(await artistFacts(about), [about])).slice(0, 2) : [];
    for (const f of extra) setCapped(structuredLabel, f, SOURCE.wikidata, MAX_KEPT);
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

  // Too busy to finish in time (#314): data facts only, kept RETRY_MS so a later play gets the AI's
  if (paced() && !pacer.aiThisSong()) {
    const sureNow = match?.level === "sure" ? { page: context.split("\n")[0], names: [...new Set([...artistNames(song.artist ?? ""), ...artistNames(read.artist ?? "")])] } : null;
    const data = (await structuredFacts(song, read, Promise.resolve(sureNow))).filter((f) => !recentFacts.includes(f) && !restatesRequest(f, song) && fitsTarget(f));
    const shown = rankedData(data, want);
    console.log(`[Pace] "${song.title}": the computer is busy, ${shown.length} quick facts and no AI`);
    if (shown.length) {
      remember(shown);
      record(asked, structuredLabel.get(shown[0]) === SOURCE.musicbrainz ? "musicbrainz" : "wikidata", shown.length);
      return { facts: toFacts(song, shown, (t) => structuredLabel.get(t)), ttlMs: RETRY_MS };
    }
    if (sourcedOnly) return none;
    const lines = entryFacts(entry, want);
    record(asked, "noReference", lines.length);
    return { facts: toFacts(song, lines, entrySource), ttlMs: RETRY_MS };
  }

  // Data facts beside the AI (artist's or game's article, or a sure one: #256), sent early so a busy PC shows them first
  const page = context.split("\n")[0];
  const sure = context && match?.level === "sure" ? { page, names: [...new Set([...artistNames(song.artist ?? ""), ...artistNames(read.artist ?? "")])] } : null;
  // At least one caption's room; at most MAX_DATA_FACTS
  const dataRoom = Math.min(MAX_DATA_FACTS, want > 1 ? want - 1 : want);
  let aiDone = false;
  let early: Fact[] = [];
  const dataFacts = (context && (!aboutTheSong(read, context) || sure) ? structuredFacts(song, read, Promise.resolve(sure)) : Promise.resolve([] as string[])).then((list) => {
    const data = list.filter((f) => !recentList().includes(f) && !restatesRequest(f, song) && fitsTarget(f));
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
  // Infobox facts, not for an edition the title lacks ("Some Game Royal" from "Some Game": the original's credits)
  const edition = context ? editionNotInTitle(read.artist ?? "", page) : null;
  if (edition) console.log(`[Infobox] "${page}" doesn't name the edition "${edition}": no infobox facts`);
  const boxLookup: Promise<BoxFact[]> = context && !edition && !blockedArticles(song).has(STRUCTURED) ? infoboxFacts(page).then((list) => boxForRequest(list, page, song, read)) : Promise.resolve([]);

  // Running late (#314): fewer captions from the article's start; fewer facts, never weaker checks
  const short = paced() && pacer.ask() === "short";
  const source = short ? shorterContext(context) : context;
  if (short) console.log(`[Pace] "${song.title}": facts have been late, asking for ${SHORT_CAPTIONS} captions from ${source.length} characters of the article`);
  const prompt = groundedPrompt(read, source, short ? SHORT_CAPTIONS : want + OVERGENERATE);
  const askedKey = songKey(asked);
  const prep = preparing();
  // Stream model, or the first-pass prep model (#296)
  const writer = prep && !prep.streamModel ? prepModelName() : streamModelName();
  // All failed last time, same article and model (#203); short asks aren't remembered
  const askedBefore = !short && screenedOut.get(askedKey) === screenedKey(page, writer);
  if (askedBefore) console.log(`[FactGen] "${song.title}": every caption from "${page}" failed the screen last time, so the AI isn't asked again`);
  // Preparing: an artist's or game's article is retold once per model for all its songs, screened per song (#296)
  const { track } = resolveGameAndTrack(read);
  const shareKey = prep && !askedBefore && !aboutTheSong(read, context) ? `${writer}\0${want}\0${process.env.PROMPT_STYLE ?? ""}\0${citesSentences()}\0${context}` : "";
  const shared = shareKey ? prep?.answers.get(shareKey) : undefined;
  let answer: string;
  try {
    // Preparing: not tied to the stream song, so a song change can't cancel it
    answer = askedBefore ? "" : shared ? shared.answer : await askModel(prompt, prep ? null : askedKey);
    if (prep?.signal.aborted) throw new Obsolete();
    if (prep && !askedBefore) prep.model = writer;
    if (prep && shareKey && !shared) setCapped(prep.answers, shareKey, { answer, track }, MAX_SHARED_ANSWERS);
  } catch (err) {
    aiDone = true;
    // AI failed: the early facts stand (not if the song changed)
    if (early.length && !(err instanceof Obsolete)) {
      console.warn(`[FactGen] The AI failed for "${song.title}": keeping the ${early.length} facts from data`);
      return { facts: early, ttlMs: RETRY_MS };
    }
    throw err;
  }
  aiDone = true;
  // Shared answer: a line naming its first song's track is about that one
  const otherTrack = shared && normalizeTitle(shared.track) !== normalizeTitle(track) ? normalizeTitle(shared.track) : "";
  const lines = answer.split("\n").map((l) => l.trim()).filter(Boolean).filter((l) => {
    if (otherTrack && mentionsName(normalizeTitle(l), [otherTrack])) {
      console.log("[Screen] DROP (names the song it was first written for)");
      return false;
    }
    if (!context || !copiesExample(l, context)) return true;
    console.log("[Screen] DROP (copies an example)");
    return false;
  });
  const songFacts = await dataFacts;
  // A cover on the original's article: only songwriter infobox facts hold
  const allBox = await boxLookup;
  // An infobox naming another artist is their record, even if the article never names this one
  const boxArtists = allBox.find((b) => b.about?.kind === "song")?.about?.artists ?? [];
  const othersBox = boxArtists.length > 0 && !boxArtists.some((a) => namesLoosely(normalizeTitle(a), artistNames(read.artist ?? "")));
  const cover = context ? othersBox || isCoverOf(page, articleText(page), read.artist ?? "", song.title) : false;
  const boxFacts = (cover ? allBox.filter((b) => /^(?:writers?|songwriters?|composer|lyricists?):/.test(b.evidence)) : allBox).filter(
    (b) => onStandard([b.text], [read.title, read.artist ?? ""]).length > 0
  );
  const cited = Boolean(context) && citesSentences();
  const { kept, rejected, sources: citedSentence } = screenClaims(lines, context, { otherParts: otherParts(context, track), track: aboutTheSong(read, context) ? undefined : track, cited, artists: artistNames(read.artist ?? "") });
  // Reason only, never the words: logs mustn't spread what was held back (#242, #262)
  for (const r of rejected) console.log(`[Screen] DROP (${r.reason})`);
  // A "someone said" caption must keep who said it
  const attributed = kept.filter((f) => {
    if (context && !keepsAttribution(f, context)) {
      console.log("[Screen] DROP (drops who said it)");
      return false;
    }
    if (loadedCaption(f, [read.title, read.artist ?? ""], isPerformerArticle(page, articleText(page) || context))) {
      console.log("[Screen] DROP (loaded wording)");
      return false;
    }
    // Opens on a sister work ("Some Game II sold")
    if (config.match === "scored" && scored && aboutAnotherWork(f, scored.request, scored.target)) {
      console.log("[Screen] DROP (about another work)");
      return false;
    }
    return true;
  });
  const unseen = attributed.filter((f) => !recentList().some((r) => tooSimilar(r, f)));
  if (unseen.length < attributed.length) console.log(`[Screen] DROP ${attributed.length - unseen.length} already shown for an earlier song`);
  // Restore a dropped limit ("in Japan", "usually"); drop the caption if it has no clear place
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
  // Fixed plain words for music terms
  const plain = new Map(fresh.map((f) => [f, explainMusicTerms(repaired.get(f) as string)]));
  // Song's data facts, then the infobox's: at most dataRoom, none a caption already says; early ones stay as sent
  const aboutSong = songFacts.filter((f) => !artistSentences.has(f));
  const candidates = [...(early.length ? [] : rankedData(aboutSong, MAX_BUBBLES)).map((text) => ({ text, values: valuesIn(text), evidence: "" })), ...boxFacts];
  const structured: string[] = early.map((f) => f.text);
  for (const c of candidates) {
    if (structured.length >= dataRoom) break;
    if (recentList().includes(c.text) || restatesRequest(c.text, song) || !fitsTarget(c.text)) continue;
    if (alreadySaid(c.values, [...fresh, ...structured])) continue;
    structured.push(c.text);
    if (c.evidence) {
      setCapped(structuredLabel, c.text, `${SOURCE.infobox}${page}`, MAX_KEPT);
      setCapped(boxEvidence, c.text, c.evidence, MAX_KEPT);
    }
  }
  // Artist fact beyond dataRoom: never displaces a song fact
  const artistFact = songFacts.find((f) => artistSentences.has(f) && !structured.includes(f) && !alreadySaid(valuesIn(f), fresh));
  if (artistFact) structured.push(artistFact);
  // A spare replaces a line that only repeats title and artist
  const usable = fresh.filter((f) => !restatesRequest(plain.get(f) as string, song));
  const cites = new Map(usable.flatMap((f) => (citedSentence?.has(f) ? [[plain.get(f) as string, citedSentence.get(f) as string] as const] : [])));
  // Sent facts first, as sent; captions fill the rest
  const room = early.length ? Math.max(0, Math.min(want, MAX_BUBBLES) - early.length) : want;
  const sent = early.map((f) => f.text);
  const lead = structured.filter((f) => !sent.includes(f));
  const captions = context && config.sourceRisk ? rankedFromArticle(lead, usable, context, plain, citedSentence, room, resolveGameAndTrack(read).track) : bestSupported(lead, usable, context, plain, citedSentence, room);
  const later = captions.filter((c) => !sent.includes(c));
  const shown = early.length ? [...sent, ...later] : captions;
  // early ones were remembered when sent
  remember(early.length ? later : shown);
  console.log(`[Screen] "${song.title}": ${lines.length} generated, ${rejected.length} dropped, ${shown.length} shown`);
  // Not for a shared answer: this song's own ask may do better
  if (lines.length && !usable.length && !short && !shared) setCapped(screenedOut, askedKey, screenedKey(page, writer), MAX_KEPT);
  else if (usable.length) screenedOut.delete(askedKey);

  if (shown.length) {
    record(asked, "grounded", shown.length);
    if (prep) prep.article = page;
    setCapped(sources, songKey(asked), page, MAX_KEPT);
    const article = `Wikipedia: ${page}`;
    // A companion article's line takes its label and link; Wrong blocks it (#48)
    const labelOf = (t: string) => {
      const companion = companionPages(context).length ? companionOf(cites.get(t) ?? supportingSentence(t, context, Infinity), context) : "";
      return companion ? `Wikipedia: ${companion}` : article;
    };
    // Found through this article: Wrong on it takes them too
    const facts = toFacts(song, shown, (t) => structuredLabel.get(t) ?? labelOf(t), context, cites).map((f) =>
      f.source?.startsWith("Wikipedia: ") && f.source !== article ? { ...f, via: article } : f
    );
    return { facts, ttlMs: Infinity };
  }
  if (sourcedOnly) return none;
  const fallback = entryFacts(entry, want);
  console.warn(`[FactGen] Nothing usable for "${song.title}", using ${fallback.length} entry and curated facts`);
  record(asked, "nothingSurvived", fallback.length);
  return { facts: toFacts(song, fallback, entrySource), ttlMs: RETRY_MS };
}

const MAX_SHARED_ANSWERS = 200; // AI answers a prep run keeps for songs sharing a reference

function preparedOutcome(entry: PreparedEntry): Outcome {
  if (entry.article) return "grounded";
  return entry.facts[0]?.source === SOURCE.musicbrainz ? "musicbrainz" : "wikidata";
}

// Prepared facts, re-checked (Wrong since, shown lately, count); null to write now. Never padded
function preparedFacts(song: SSLSong, asked: SSLSong, want: number): Generated | null {
  if (preparing() || !config.factVerification) return null;
  const key = songKey(asked);
  const entry = preparedStore.get(key);
  if (!entry || entry.outcome !== "facts" || !entry.facts.length) return null;
  const blocked = new Set([...blockedArticles(asked), ...blockedArticles(song)]);
  if (entry.facts.some((f) => blocked.has(blockFor(f.source) ?? "") || blocked.has(blockFor(f.via) ?? ""))) {
    preparedStore.remove(key);
    console.log(`[Prepared] "${song.title}": a source was marked Wrong after it was prepared, so it's looked up again`);
    return null;
  }
  const recent = recentList();
  const fresh = entry.facts.filter((f) => !recent.some((r) => tooSimilar(r, f.text)) && !restatesRequest(f.text, song)).slice(0, Math.min(want, MAX_BUBBLES));
  if (!fresh.length) return null;
  remember(fresh.map((f) => f.text));
  record(asked, preparedOutcome(entry), fresh.length);
  // Wrong's fallback for unlabeled facts
  if (entry.article) setCapped(sources, key, entry.article, MAX_KEPT);
  setCapped(structuredShown, key, new Set(fresh.filter((f) => blockFor(f.source) === STRUCTURED).map((f) => f.text)), MAX_KEPT);
  const spotFor = spotsForSong(song);
  const facts = fresh.map((f, i): Fact => ({
    text: f.text,
    ...(f.source ? { source: f.source } : {}),
    ...(f.url ? { url: f.url } : {}),
    ...(f.evidence ? { evidence: f.evidence } : {}),
    ...(f.via ? { via: f.via } : {}),
    delaySeconds: i * config.factIntervalSeconds,
    durationSeconds: config.factDurationSeconds,
    ...spotFor(i),
  }));
  console.log(`[Prepared] "${song.title}": ${facts.length} facts prepared ahead of time`);
  return { facts, ttlMs: Infinity };
}

/** One song's preparation; outcome null = try again (stopped, failed, a lookup unanswered) */
export interface PreparedSong {
  outcome: PreparedOutcome | null;
  facts: PreparedFact[];
  article: string;
  model: string;
  /** Failed or throttled lookups: a miss then proves nothing */
  trouble: number;
}

// Outcome -> stored as facts, none, own (nothing to prepare) or live (found only live); missing = try again
const STORED: Partial<Record<Outcome, PreparedOutcome>> = {
  grounded: "facts",
  wikidata: "facts",
  musicbrainz: "facts",
  noReference: "none",
  nothingSurvived: "none",
  liveLearn: "none",
  songFacts: "own",
  original: "own",
  factsOff: "own",
  notMusic: "own",
  twitchAbout: "live",
};

/** Prepares a song as it would play, sourced facts only (#293); `streamModel`: second pass (#296). Never throws */
export async function prepareSong(
  song: SSLSong,
  signal: AbortSignal,
  opts: { answers?: PrepContext["answers"]; revisionOf?: (page: string) => Promise<number | null>; streamModel?: boolean } = {}
): Promise<PreparedSong & { revision: number }> {
  watchLookupTrouble();
  const revisionOf = opts.revisionOf ?? settledRevision;
  const ctx: PrepContext = { recent: [], trouble: 0, signal, answers: opts.answers ?? new Map(), ...(opts.streamModel ? { streamModel: true } : {}) };
  const empty = { facts: [] as PreparedFact[], article: "", model: "", revision: 0 };
  // Switched off or not music: nothing looked up (#262)
  const off = factsOff(song);
  if (off.song || off.artist || isNotMusic(song)) return { ...empty, outcome: "own", trouble: 0 };
  try {
    const result = await prepContext.run(ctx, async () => {
      const r = await generateRest(song, null, config.factsPerSong);
      // To tell later if the article changed
      const revision = ctx.article && STORED[ctx.outcome as Outcome] === "facts" ? await revisionOf(ctx.article).catch(() => null) : null;
      return { ...r, revision: revision ?? 0 };
    });
    if (signal.aborted) return { ...empty, outcome: null, trouble: ctx.trouble };
    const outcome = STORED[ctx.outcome as Outcome] ?? null;
    const facts = outcome === "facts" ? result.facts.filter(fromASource).map((f) => ({ text: f.text, ...(f.source ? { source: f.source } : {}), ...(f.url ? { url: f.url } : {}), ...(f.evidence ? { evidence: f.evidence } : {}), ...(f.via ? { via: f.via } : {}) })) : [];
    return {
      outcome: outcome === "facts" && !facts.length ? "none" : outcome,
      facts,
      article: outcome === "facts" ? (ctx.article ?? "") : "",
      model: ctx.model ?? "",
      revision: result.revision,
      trouble: ctx.trouble,
    };
  } catch (err) {
    console.warn(`[Prepared] "${song.title}" couldn't be prepared: ${err instanceof Error ? err.message : err}`);
    return { ...empty, outcome: null, trouble: ctx.trouble };
  }
}

// rankFacts: risky-sentence captions held back unless under three; by interest, data and lead first among equals
function rankedFromArticle(
  data: string[],
  captions: string[],
  context: string,
  plain: ReadonlyMap<string, string>,
  cited: ReadonlyMap<string, string> | undefined,
  want: number,
  title = ""
): string[] {
  const full = articleText(context.split("\n")[0]);
  const candidates: Candidate[] = [
    ...data.map((text) => ({ text, kind: "data" as const })),
    ...captions.map((f) => {
      const sentence = cited?.get(f) ?? supportingSentence(f, context, Infinity);
      return { text: plain.get(f) as string, kind: "caption" as const, sentence, lead: isLeadSentence(sentence, context, full) };
    }),
  ];
  // Data facts lead (about the song; the article is its artist's or game's). Other songs' captions: low, one at most
  const artistArticle = isPerformerArticle(context.split("\n")[0], full || context);
  return rankFacts(candidates, { max: Math.min(want, MAX_BUBBLES), dataFirst: true, artistArticle, title, log: (line) => console.log(line) }).map((c) => c.text);
}

// SOURCE_RISK=off: data facts, then the best-supported captions in order
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

/** Without the artist's bracket note or the title's requester credit; same object if neither */
export function withoutNote(song: SSLSong): SSLSong {
  const artist = withoutArtistNote(song.artist ?? "");
  const title = withoutRequestCredit(song.title) || song.title;
  return artist === (song.artist ?? "").trim() && title === song.title ? song : { ...song, title, artist };
}

// Own facts, live learn, original, then groundedFacts. `sourcedOnly`: no entry facts. `asked`: the request;
// work and outcome go under it, or the built-in model took the reading for a song gone and refused
async function generateRest(listed: SSLSong, entry: SSLQueueItem | null, want: number, sourcedOnly = false, asked: SSLSong = listed, onEarly?: EarlyFacts): Promise<Generated> {
  // As listed: a bracket note may be an alias
  const own = ownSongFacts(listed, want, asked);
  if (own) return own;
  // Note gone from here on: never searched, sent to the AI, shown or logged (#262)
  const song = withoutNote(listed);
  if (song.liveLearn) return liveLearnFacts(song, want, asked);
  const byTitle = await titleOnlyReading(song);
  if (byTitle) return generateRest(byTitle, entry, want, sourcedOnly, asked);
  const none = { facts: [] as Fact[], ttlMs: RETRY_MS };

  try {
    return (await friendsOriginalAbout(song, entry, want, asked)) ?? originalFacts(song, entry, want, asked) ?? (await groundedFacts(song, entry, want, sourcedOnly, asked, onEarly));
  } catch (err) {
    if (err instanceof Obsolete) {
      // Not cached: a returning song gets a real try
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

/** Facts switched off (#262) or not music: only the streamer's song and tagged facts, nothing looked up; null otherwise */
export function ownFactsOnly(song: SSLSong): Fact[] | null {
  const off = factsOff(song);
  const notMusic = isNotMusic(song);
  if (!off.song && !off.artist && !notMusic) return null;
  const want = config.factsPerSong;
  const theirs = findSongFacts(song);
  const mine = theirs && hasOwnFacts(theirs) ? songFactLines(theirs, want) : [];
  const tagged = taggedFor(song);
  const custom = [...tagged.forSong, ...takeTurns(tagged.pool, Math.max(0, want - mine.length - tagged.forSong.length))]
    .filter((t) => !mine.includes(t))
    .slice(0, Math.max(0, want - mine.length));
  const why = off.song ? "facts are off for this song" : off.artist ? "facts are off for this artist" : "this doesn't look like music";
  console.log(`[FactGen] "${song.title}": ${why}, so only the streamer's own (${mine.length + custom.length})`);
  record(song, off.song || off.artist ? "factsOff" : "notMusic", mine.length + custom.length);
  return toFacts(song, [...mine, ...custom], (t) => (mine.includes(t) ? SOURCE.yours : SOURCE.custom));
}

/** After a switch change: all, or only the streamer's own */
export function allowedFacts(song: SSLSong, facts: Fact[]): Fact[] {
  const off = factsOff(song);
  return off.song || off.artist || isNotMusic(song) ? facts.filter((f) => WRITTEN_BY_STREAMER.has(f.source)) : facts;
}

/** A song's facts; cached, and simultaneous callers share one generation */
export function generateFacts(song: SSLSong, entry: SSLQueueItem | null = null, onEarly?: EarlyFacts): Promise<Fact[]> {
  // Before the cache: switches apply at once, both ways
  const own = ownFactsOnly(song);
  if (own) return Promise.resolve(own);
  const key = songKey(song);
  const cached = factCache.get(key);
  if (cached && Date.now() < cached.expires) {
    factStats.cacheHits++;
    aiTimes.delete(key);
    return Promise.resolve(cached.facts);
  }
  const revisionAtStart = revisions.get(key) ?? 0;
  let pending = inFlight.get(key);
  if (!pending) {
    const started = Date.now();
    aiTimes.delete(key);
    pending = generate(song, entry, onEarly)
      .then(({ facts, ttlMs }) => {
        if (aiAsked.has(key)) {
          // Viewers' wait, from song start, for the song on now (#314)
          if (paced() && key === currentKey) {
            const before = pacer.pace();
            const waited = Math.max(0, Date.now() - songStartedAt);
            pacer.ready(waited);
            logPace(before, waited, false);
          }
          aiTimes.set(key, Date.now() - started);
          console.log(`[FactGen] "${withoutRequestCredit(song.title)}": facts took ${((Date.now() - started) / 1000).toFixed(1)}s with the AI`);
        }
        // Started before the facts changed: don't overwrite
        if ((revisions.get(key) ?? 0) === revisionAtStart) setCapped(factCache, key, { facts, expires: Date.now() + ttlMs }, MAX_KEPT);
        return facts;
      })
      .finally(() => {
        aiAsked.delete(key);
        if (inFlight.get(key) === pending) inFlight.delete(key);
      });
    inFlight.set(key, pending);
  }
  // Superseded while running: start over
  return pending.then((facts) => ((revisions.get(key) ?? 0) === revisionAtStart ? facts : generateFacts(song, entry, onEarly)));
}

/** Data facts sent while the AI writes (#256); generateFacts' full list starts with them unchanged */
export type EarlyFacts = (facts: Fact[]) => void;

// Bumped on change; older generations are discarded
const revisions = new Map<string, number>();

/** Tests only. Keeps outcomes (true for /recent), structuredLabel (fixed) and Wrong blocks (Undo only) */
export function clearFactCache(): void {
  factCache.clear();
  recentFacts.length = 0;
  poolTurns.clear();
  inFlight.clear();
  sources.clear();
  structuredShown.clear();
  screenedOut.clear();
  resetCuratedTurns();
  clearInfoboxCache();
  clearArtistGoodCache();
}

// The request, plus what a live learn or bare title was looked up as
function blockedAs(song: SSLSong): SSLSong[] {
  const byTitle = song.titleOnly ? cachedArtistByTitle(song.title) : "";
  const lookup = song.liveLearn ? liveLearnLookup(song) : byTitle ? { ...song, artist: byTitle, titleOnly: undefined } : null;
  return lookup ? [song, lookup] : [song];
}

/** What a label blocks: article, STRUCTURED, Twitch About, or null (streamer's or song list's); undefined with no label */
export function blockFor(label: string | undefined): string | null | undefined {
  if (!label) return undefined;
  if (label.startsWith("Wikipedia: ")) return label.slice("Wikipedia: ".length);
  // A wrong infobox fact usually means the wrong article
  if (label.startsWith(SOURCE.infobox)) return label.slice(SOURCE.infobox.length);
  if (label === SOURCE.wikidata || label === SOURCE.musicbrainz) return STRUCTURED;
  // Likely a stranger with the artist's name: block that channel
  if (label.startsWith(SOURCE.twitchAbout)) return label;
  return null;
}

/** Bubbles Wrong removes (#262): the marked one and all from its source, as a wrong fact usually means a wrong source */
export function pulledWithWrong(facts: Fact[], fact: Fact): Fact[] {
  const source = blockFor(fact.source);
  // Companion facts go with their article (#48)
  return facts.filter((f) => f.text === fact.text || (!!source && (blockFor(f.source) === source || blockFor(f.via) === source)));
}

/** "song", "custom" or null: Wrong can't block the streamer's own, so the app offers an edit */
export function ownFactKind(label: string | undefined): "song" | "custom" | null {
  return label === SOURCE.yours ? "song" : label === SOURCE.custom ? "custom" : null;
}

/** Blocks a wrong fact's source (by label: survives a restart) and forgets the song's facts; returns the source or null */
export function markWrong(song: SSLSong, text: string, label?: string): string | null {
  const key = songKey(song);
  const fromLabel = blockFor(label);
  const source = fromLabel !== undefined ? fromLabel : structuredShown.get(key)?.has(text) ? STRUCTURED : (sources.get(key) ?? null);
  // Prepared facts too: prepared again without that source
  if (source) for (const s of blockedAs(song)) {
    blockArticle(s, source);
    preparedStore.remove(songKey(s));
  }
  const dropped = new Set((factCache.get(key)?.facts ?? []).map((f) => f.text));
  for (let i = recentFacts.length - 1; i >= 0; i--) if (dropped.has(recentFacts[i])) recentFacts.splice(i, 1);
  // A running generation mustn't cache it: start over (as forgetSong)
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
  inFlight.delete(key);
  factCache.delete(key);
  sources.delete(key);
  structuredShown.delete(key);
  if (!ownFactKind(label)) logWrong(song, text, label, source); // private test case for scripts/wrong-cases.mjs
  console.log(`[WrongFact] "${song.title}": ${source ? `won't use ${source === STRUCTURED ? source : `"${source}"`} again` : "not from a lookup"}`);
  return source;
}

/** Screened captions for a made-up song; the packaged-app smoke test runs two at once (loading alone proved too little) */
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

/** After a song's own facts change: its next generation starts over */
export function forgetSong(song: SSLSong): void {
  const key = songKey(song);
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
  factCache.delete(key);
  inFlight.delete(key);
  // Old sources too: Wrong on new facts mustn't block an old article
  sources.delete(key);
  structuredShown.delete(key);
  screenedOut.delete(key);
}

/** Undo Wrong for the song */
export function unmarkWrong(song: SSLSong, source: string): void {
  for (const s of blockedAs(song)) unblockArticle(s, source);
  console.log(`[WrongFact] "${song.title}": "${source}" allowed again`);
}

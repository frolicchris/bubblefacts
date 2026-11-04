/**
 * One scored match between a request and the articles a lookup found (issue #172).
 *
 * The rules in fact-verifier.ts (`workMatchConfidence`, `summaryMismatch`, `articleMisfit`)
 * each check one way an article can be about another work. This module reads every signal at
 * once: what the request says (its title, the work it is from, a year, what the artist field
 * is) against what each article says (its title, kind, year, performer, "a remake of"). Each
 * signal adds or takes points; the total decides:
 * - `sure`: captions and data facts, as today;
 * - `data-only`: no captions, only data that holds for every version (who wrote it);
 * - `abstain`: no facts from the lookup.
 *
 * Pure: no I/O. The caller passes in what the pipeline already fetched.
 * MATCH=rules keeps today's rules alone; shadow scores and logs; scored lets the score hold facts back.
 */
import { SSLSong } from "./types";
import type { WorkMatch } from "./fact-verifier";
import {
  describedKind,
  editDistance,
  isConcertFilm,
  isInitials,
  isPerformerArticle,
  isPieceArticle,
  isRespelling,
  mentionsName,
  namesLoosely,
  namesPiece,
  normalizeTitle,
  numeralStyleDiffers,
  openingSays,
  parseClassicalTitle,
  qualifierNamesAnotherArtist,
  resolveGameAndTrack,
  themeOf,
  workFromTitle,
  artistNames,
} from "./fact-verifier";
import { PLATFORM_TAG } from "./infobox";

/** What the artist field names: who sings it, who wrote it, the work it's from, or can't tell. */
export type ArtistKind = "performer" | "composer" | "work" | "unknown";
/** What an article is about. `music`: a work's music article ("Music of X", "X Soundtrack"). */
export type WorkKind = "song" | "album" | "music" | "person" | "game" | "film" | "tv" | "book" | "stage" | "series" | "other";
export type Decision = "sure" | "data-only" | "abstain";

export interface RequestProfile {
  /** The piece asked for, or "" when the request is a whole work. */
  piece: string;
  /** The artist field's work or name, or a longer one the title gives ("Some Game 2: Track" by "Some Game"). */
  field: string;
  /** The work the title says the piece is from, "(from Some Show)", or what a theme is named for. */
  hint: string;
  /** A year in the title's brackets, "(1987)". */
  year: number | null;
  artistKind: ArtistKind;
  /** The artist field's names, normalized (`artistNames`). */
  names: string[];
  /** Each name in a shared credit, "Some Singer / Other Singer": each may have the article. */
  credits: string[];
  /** How the title says it is played: cover, live, cast, remix. */
  versions: string[];
  /** What the request's own brackets say the work is: "Some Quest (SNES)" a game, "Some Show (TV)" a show or film. */
  medium: "game" | "screen" | "";
}

export interface CandidateProfile {
  page: string;
  /** The title without its qualifier, normalized. */
  base: string;
  qualifier: string;
  kind: WorkKind;
  /** The year the qualifier or first sentence gives a work (never a person's). */
  year: number | null;
  /** The first two sentences, normalized. "" for a title known only from a search. */
  lead: string;
  /** The text read for it, for `namesPiece`. */
  text: string;
  /** "a remake of X", "a sequel to X": X, normalized. */
  remakeOf: string;
  /** Its place in the search results, 0 first; -1 when not from a search. */
  rank: number;
}

export interface Scored {
  page: string;
  points: number;
  /** Each feature and its points, in order. */
  parts: Array<[string, number]>;
}

export interface MatchResult {
  decision: Decision;
  top: Scored;
  /** The best article of the same name, when there is one. */
  runnerUp: Scored | null;
  /** The work the facts would be about. */
  target: { page: string; kind: WorkKind; year: number | null };
  /** The request as scored, for the checks on each fact. */
  request: RequestProfile;
}

/** The points, set by hand (issue #172). */
export const POINTS = {
  titleExact: 4,
  respelling: 3,
  titleClose: 2,
  namedInLead: 2,
  titleAbsent: -4,
  parentWork: -3,
  siblingWork: -4,
  performerRequested: 3,
  performerOther: -3,
  kindFits: 3,
  kindCompatible: 1,
  kindConflicts: -5,
  namesHintedWork: 3,
  yearClose: 2,
  yearFar: -3,
  topHit: 1,
} as const;

/** Sure needs this many points and this lead over an article of the same name; data only needs `DATA_ONLY`. */
export const SURE = 6;
export const MARGIN = 3;
export const DATA_ONLY = 3;

const YEAR = /\b(1[89]\d\d|20\d\d)\b/;
const YEAR_TAG = /[([]\s*((?:19|20)\d\d)\s*[)\]]/;
/** A show's or a film's own bracket: "Some Show (TV)", "Theme (Some Show TV series)". */
const SCREEN_TAG = /\((?:[^)]*\s)?(?:tv|tv series|television|anime|film|movie|sitcom)\)\s*$/i;
const VERSION_WORDS: Array<[string, RegExp]> = [
  ["cover", /\bcover\b/i],
  ["live", /\blive\b|\bunplugged\b|\btiny desk\b/i],
  ["cast", /\bcast\b|\bbroadway\b/i],
  ["remix", /\bremix\b|\bmix\)|\bedit\)/i],
];
/** Words that name an edition of a work rather than another work. */
const EDITION = /^(?:complete|remastered|remaster|definitive|deluxe|hd|dx|anniversary|edition|special|ultimate|enhanced)$/;
const STOP = new Set(["the", "and", "of", "a", "an", "in", "on", "for", "to"]);
const ROMAN: Record<string, string> = { i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10" };

/** Content words, roman numerals as numbers: "Some Game V" and "Some Game 5" are one. */
export function tokens(s: string): string[] {
  return normalizeTitle(s)
    .replace(/ (?:series|franchise)$/, "")
    .split(" ")
    .filter((t) => t && !STOP.has(t))
    .map((t) => ROMAN[t] ?? t);
}

const qualifierOf = (page: string) => /\(([^)]*)\)\s*$/.exec(page)?.[1] ?? "";
const withoutQualifier = (page: string) => page.replace(/\s*\([^)]*\)\s*$/, "");
/** "Music of Some Game", "Some Game Original Soundtrack", "Music of the Some series": the work the music is of. */
const musicOf = (base: string) =>
  base
    .replace(/^music (?:of|from) (?:the )?/i, "")
    .replace(/\s+(?:original )?(?:video game )?(?:soundtrack|ost|score)$/i, "")
    .replace(/\s+series$/i, "");

function firstSentences(full: string, n: number): string {
  const lead = full.split(/\n==/)[0].replace(/\s+/g, " ").trim();
  const ends = [...lead.matchAll(/[.!?](?=\s+[\p{Lu}"“(])/gu)].map((m) => (m.index ?? 0) + 1);
  return ends.length >= n ? lead.slice(0, ends[n - 1]) : lead;
}

// --- The request ------------------------------------------------------------

/**
 * What a request says about the work it wants. `asked` is the request as typed, `read` the
 * reading that found the article. `credited`: MusicBrainz has this title by an artist of the
 * artist field's name (null: not looked up).
 */
export function requestProfile(asked: SSLSong, read: SSLSong, credited: boolean | null = null): RequestProfile {
  const { game, track } = resolveGameAndTrack(read);
  const piece = track && normalizeTitle(track) !== normalizeTitle(game) ? track : "";
  const year = Number(YEAR_TAG.exec(asked.title)?.[1] ?? NaN);
  const artist = (asked.artist ?? "").trim();
  // The title's own "Some Game 2:" in front of the track, longer than the artist field: a work.
  const longer = normalizeTitle(game) !== normalizeTitle(read.artist ?? "") && Boolean(read.artist);
  const kind: ArtistKind = PLATFORM_TAG.test(artist) || longer
    ? "work"
    : credited
      ? "performer"
      : parseClassicalTitle(read.title).classical && /\s/.test(game)
        ? "composer"
        : "unknown";
  return {
    piece,
    field: game,
    // The work it is from, or what a theme is named for: "Some Song (from Some Show)", "Some Name Theme".
    hint: workFromTitle(asked.title)?.work || themeOf(read.title),
    year: Number.isFinite(year) ? year : null,
    artistKind: kind,
    names: [...new Set([...artistNames(asked.artist ?? ""), ...artistNames(read.artist ?? "")])],
    credits: game.split(/\s*(?:\/|,|;|\s(?:feat\.?|ft\.?|featuring|with|x)\s)\s*/i).map((n) => n.trim()).filter((n) => n && n !== game),
    versions: VERSION_WORDS.filter(([, re]) => re.test(asked.title)).map(([v]) => v),
    medium: PLATFORM_TAG.test(artist) || /\((?:video )?game\)\s*$/i.test(artist) ? "game" : [artist, asked.title].some((t) => SCREEN_TAG.test(t)) ? "screen" : "",
  };
}

// --- An article -------------------------------------------------------------

function kindOf(qualifier: string, description: string, full: string, page: string): WorkKind {
  const q = qualifier.toLowerCase();
  const fromWords = (s: string): WorkKind | null => {
    if (/\b(?:concert|documentary|film|movie)\b/.test(s)) return "film";
    if (/\b(?:video )?game\b/.test(s)) return "game";
    if (/\b(?:tv series|television|miniseries|anime|sitcom)\b/.test(s)) return "tv";
    if (/\bsoundtrack\b/.test(s)) return "music";
    if (/\b(?:song|single|instrumental|composition|hymn|aria|anthem)\b/.test(s)) return "song";
    if (/\b(?:album|ep|mixtape|compilation)\b/.test(s)) return "album";
    if (/\b(?:band|singer|musician|rapper|group|duo|composer|pianist|orchestra|dj|producer|guitarist)\b/.test(s)) return "person";
    if (/\b(?:novel|manga|book|comic)\b/.test(s)) return "book";
    if (/\b(?:a|the|stage|broadway|\d{4}) musical\b(?! (?:project|group|act|artist|duo|band|collective))|\bopera\b|\bballet\b|\bplay\b/.test(s)) return "stage";
    if (/\b(?:jazz |pop )?standards?\b|\btunes?\b/.test(s)) return "song";
    if (/\b(?:series|franchise)\b/.test(s)) return "series";
    return null;
  };
  if (/^music (?:of|from) /i.test(page) || /\b(?:soundtrack|ost)$/i.test(withoutQualifier(page))) return "music";
  const byQualifier = q ? fromWords(q) : null;
  if (byQualifier) return byQualifier;
  if (full && isConcertFilm(page, full)) return "film";
  const described = description ? describedKind(description) : "other";
  if (described !== "other") return described === "person" ? "person" : described;
  if (!full) return "other";
  // What the first sentence calls it, by the kind word nearest "by" or "of": "the debut single of singer X" is a song.
  const opening = describedKind(openingSays(full));
  if (opening !== "other") return opening;
  if (isPerformerArticle(page, full)) return "person";
  if (isPieceArticle(page, full)) return "song";
  return fromWords(openingSays(full).toLowerCase()) ?? "other";
}

/**
 * What an article says it is. `full`: its text as read ("" for a title only a search gave);
 * `description`: Wikipedia's short description, when read; `rank`: its search place.
 */
export function candidateProfile(page: string, full = "", description = "", rank = -1): CandidateProfile {
  const qualifier = qualifierOf(page);
  const kind = kindOf(qualifier, description, full, page);
  const first = full ? firstSentences(full, 1) : "";
  const year = kind === "person" ? null : Number(YEAR.exec(qualifier)?.[1] ?? YEAR.exec(first.replace(/\([^)]*\)/g, ""))?.[1] ?? NaN);
  const two = full ? firstSentences(full, 2) : "";
  const remake = /\b(?:remake|reboot|remaster|reimagining|sequel|prequel|spin-?off) (?:of|to) (?:the )?(?:\d{4} )?(?:[\w-]+ )?(?:video game |game |film )?["“]?([^,.;"”()]{2,80})/i.exec(two)?.[1] ?? "";
  return {
    page,
    base: normalizeTitle(withoutQualifier(page)),
    qualifier,
    kind,
    year: Number.isFinite(year) ? year : null,
    lead: normalizeTitle(two),
    text: full,
    remakeOf: normalizeTitle(remake),
    rank,
  };
}

// --- Scoring ----------------------------------------------------------------

type Role = "piece" | "field" | "hint";

/**
 * How a title compares with a name the request gives. Shorter: the series, or the game an
 * edition is of. Longer by a part at the end: a sequel, a remake, another work named after it
 * ("Some Band of Darkness" for Some Band); a person's full name is no other work. Longer in the
 * middle: an article on several works at once ("Some Game Red, Blue and Yellow").
 */
function titleFit(base: string, name: string, person: boolean): { what: string; points: number } {
  const have = tokens(base);
  const want = tokens(name);
  if (!want.length || !have.length) return { what: "absent", points: POINTS.titleAbsent };
  const same = have.length === want.length && want.every((t) => have.includes(t));
  if (same && !numeralStyleDiffers(name, base)) return { what: "exact", points: POINTS.titleExact };
  if (same || isRespelling(name, base)) return { what: "respelling", points: POINTS.respelling };
  // A person's name in another order or form: "Chen Yupeng" for "Yu-peng Chen", "Our Lady Peace" for "OLP", "Johann Sebastian Bach" for "Bach, J.S.".
  if (person) {
    const letters = (list: string[]) => list.join("").split("").sort().join("");
    const initials = want.filter((t) => t.length === 1);
    const words = want.filter((t) => t.length > 1);
    if (letters(want) === letters(have) || isInitials(name, base)) return { what: "respelling", points: POINTS.respelling };
    if (initials.length && words.length && words.every((t) => have.includes(t)) && initials.every((i) => have.some((t) => !words.includes(t) && t[0] === i))) return { what: "respelling", points: POINTS.respelling };
  }
  if (have.every((t) => want.includes(t))) return person ? { what: "close", points: POINTS.titleClose } : { what: "parent", points: POINTS.parentWork };
  if (want.every((t) => have.includes(t))) {
    if (person) return { what: "close", points: POINTS.titleClose };
    // The same game under its fuller edition's name: "Some Quest Complete" for "Some Quest".
    const extra = have.filter((t) => !want.includes(t));
    if (extra.every((t) => EDITION.test(t))) return { what: "edition", points: POINTS.respelling };
    return want.every((t, i) => have[i] === t) ? { what: "sibling", points: POINTS.siblingWork } : { what: "combined", points: 0 };
  }
  // A typo or a list's cut-off title: "en You're in Love" for "When You're in Love".
  const a = want.join("");
  const b = have.join("");
  if (a.length >= 8 && editDistance(a, b) <= Math.floor(a.length * 0.2)) return { what: "close", points: POINTS.titleClose };
  return { what: "absent", points: POINTS.titleAbsent };
}

/** How an article's kind fits what the request's name is. */
function kindFit(kind: WorkKind, role: Role, artistKind: ArtistKind, medium: RequestProfile["medium"] = ""): number {
  if (kind === "other") return 0;
  // The request says what its work is: a show's theme is not a same-named game's music, nor the other way round.
  if (role !== "piece" && medium === "screen" && kind === "game") return POINTS.kindConflicts;
  if (role !== "piece" && medium === "game" && (kind === "film" || kind === "tv")) return POINTS.kindConflicts;
  const work: WorkKind[] = ["game", "film", "tv", "series", "music", "album", "book", "stage"];
  if (role === "piece") {
    if (kind === "song") return POINTS.kindFits;
    if (kind === "album" || kind === "music") return POINTS.kindCompatible;
    return POINTS.kindConflicts;
  }
  if (role === "hint") return work.includes(kind) ? POINTS.kindFits : kind === "song" ? POINTS.kindCompatible : POINTS.kindConflicts;
  // The artist field.
  if (artistKind === "performer" || artistKind === "composer") {
    if (kind === "person") return POINTS.kindFits;
    if (kind === "album" || kind === "song" || kind === "music") return POINTS.kindCompatible;
    return POINTS.kindConflicts;
  }
  if (artistKind === "work") return kind === "person" ? POINTS.kindConflicts : work.includes(kind) ? POINTS.kindFits : POINTS.kindCompatible;
  return POINTS.kindFits;
}

/**
 * The article's points for the request, with each feature's share. A title known only from a
 * search (no text) is taken at its best: its kind fits unless its qualifier says otherwise.
 */
export function scoreCandidate(req: RequestProfile, c: CandidateProfile): Scored {
  const parts: Array<[string, number]> = [];
  const add = (name: string, points: number) => {
    if (points) parts.push([name, points]);
  };
  const base = c.kind === "music" ? normalizeTitle(musicOf(c.base)) : c.base;
  const names: Array<[Role, string]> = [];
  if (req.piece) names.push(["piece", req.piece]);
  if (req.field) names.push(["field", req.field]);
  for (const credit of req.credits) names.push(["field", credit]);
  if (req.hint) names.push(["hint", req.hint]);
  // The name the title fits best; at a tie the piece's own article, then the artist field's.
  let best: { role: Role; name: string; what: string; points: number } | null = null;
  for (const [role, name] of names) {
    // A person, or a thing no kind word places (a character, a place): a longer title is a fuller name, not another work.
    const fit = titleFit(base, name, c.kind === "person" || (c.kind === "other" && Boolean(c.text)));
    // Named by nothing: the work it would be from decides its kind, not the piece.
    if (!best || fit.points > best.points || (fit.points === best.points && best.what === "absent")) best = { role, name, ...fit };
  }
  if (!best) return { page: c.page, points: 0, parts };
  // A classical title ("Sonata No. 1 in F minor, Op. 2") is found by its catalog number, not its words:
  // the piece's article under its own name, naming the composer, is the piece.
  const classical = parseClassicalTitle(req.piece || req.field).classical;
  if (classical && (best.what === "absent" || best.what === "parent") && c.kind === "song" && req.names.length && namesLoosely(normalizeTitle(`${c.qualifier} ${c.lead}`), req.names)) {
    best = { ...best, role: "piece", what: "classical piece", points: POINTS.titleExact };
  }
  // Shorter than the work asked for, but its opening names all of it: the edition's own article.
  const fullName = tokens(best.name);
  const lead = tokens(c.lead);
  const leadHas = lead.length > 0 && fullName.every((t) => lead.includes(t));
  if (best.what === "parent" && leadHas) add("title parent, lead names it", POINTS.respelling);
  else add(`title ${best.what}`, best.points);
  // The work the title says it is from, or that its theme is named for, is this article.
  if (best.role === "hint" && (best.what === "exact" || best.what === "respelling")) add("is the hinted work", POINTS.namesHintedWork);

  const piece = req.piece ? normalizeTitle(req.piece) : "";
  const namesIt = Boolean(piece) && best.role !== "piece" && Boolean(c.text) && (mentionsName(c.lead, [piece]) || namesPiece(c.text, req.piece));
  if (namesIt) add("names the piece", POINTS.namedInLead);

  // A title only a search gave is never read: its qualifier counts, but never as a full fit.
  const work = req.hint || (req.artistKind === "work" || req.artistKind === "unknown" ? req.field : "");
  const q = tokens(c.qualifier);
  const ownQualifier = Boolean(work) && q.length > 0 && q.every((t) => tokens(work).includes(t));
  let fit = kindFit(c.kind, best.role, req.artistKind, req.medium);
  // "Some Name (Some Game)" for a track of Some Game: the game's own character or place.
  if (best.role === "piece" && ownQualifier && fit < 0) fit = 0;
  // A game's article that names the track is the track's game, whatever MusicBrainz calls the artist field.
  if (best.role === "field" && namesIt && fit < 0 && (c.kind === "game" || c.kind === "music")) fit = 0;
  // Read, but of no kind the words tell (a character, a puppet): its own name is the request's.
  if (best.role !== "piece" && c.kind === "other" && c.text && best.what === "exact") fit = POINTS.kindCompatible;
  add(`kind ${c.kind}`, c.text ? fit : Math.min(fit, POINTS.kindCompatible));

  // A title only a search gave: its title and kind alone. Its qualifier can say it is a performer
  // ("Some Name (band)"), but a song or album it calls the artist's is that artist's other work, no rival.
  if (!c.text) {
    if (best.role === "field" && c.kind === "person" && req.artistKind !== "work") add("is a performer", POINTS.performerRequested);
    if (best.role === "piece" && req.names.length && (c.kind === "song" || c.kind === "album") && qualifierNamesAnotherArtist(c.page, req.field, req.piece)) add("another performer", POINTS.performerOther);
    return { page: c.page, points: parts.reduce((a, [, p]) => a + p, 0), parts };
  }
  // Who performs it. Not for a composer's piece or a game's track: the article may name the band that recorded it.
  if (req.artistKind === "performer" || req.artistKind === "unknown") {
    if (best.role === "field" && c.kind === "person") add("is the performer", POINTS.performerRequested);
    else if (best.role === "piece" && (c.kind === "song" || c.kind === "album")) {
      const opening = normalizeTitle(`${c.qualifier} ${firstSentences(c.text, 3)}`);
      if (req.names.length && namesLoosely(opening, req.names)) add("performer named", POINTS.performerRequested);
      else if (req.names.length && qualifierNamesAnotherArtist(c.page, req.field, req.piece)) add("another performer", POINTS.performerOther);
      // MusicBrainz has this song by the artist, but its article never names them: another song of that name, or a cover's original.
      else if (req.artistKind === "performer") add("performer not named", POINTS.performerOther);
    }
  }

  // The work it is from: the piece's article naming it, or a sibling's "remake of" it.
  if (work && best.role === "piece") {
    const w = normalizeTitle(work);
    if (mentionsName(normalizeTitle(`${c.qualifier} ${c.lead}`), [w])) add("names the work", POINTS.namesHintedWork);
  }
  if (c.remakeOf && best.what !== "exact") {
    const of = tokens(c.remakeOf);
    if (names.some(([, n]) => tokens(n).every((t) => of.includes(t)))) add("remake or sequel of it", POINTS.siblingWork);
  }

  if (req.year && c.year && c.kind !== "person") {
    const gap = Math.abs(req.year - c.year);
    if (gap <= 1) add("year", POINTS.yearClose);
    else if (gap > 2) add(`year ${c.year}`, POINTS.yearFar);
  }
  if (c.rank === 0) add("top hit", POINTS.topHit);
  return { page: c.page, points: parts.reduce((a, [, p]) => a + p, 0), parts };
}

/** Two titles one name could mean: the same title, or one the other plus more ("Some Game" and "Some Game: Reforged"). */
export function sameName(a: CandidateProfile, b: CandidateProfile): boolean {
  const x = tokens(a.base);
  const y = tokens(b.base);
  if (!x.length || !y.length) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.every((t, i) => long[i] === t);
}

/**
 * The decision for the picked article (`pick`), against the other titles the lookup saw.
 * Only articles of the same name compete: the artist's own article and their song's are not rivals.
 */
export function resolveWork(req: RequestProfile, pick: CandidateProfile, others: CandidateProfile[] = []): MatchResult {
  const top = scoreCandidate(req, pick);
  // A work's music article and the work's own article are one work, not rivals.
  const work = (c: CandidateProfile) => normalizeTitle(c.kind === "music" ? musicOf(c.base) : c.base);
  const oneWork = (o: CandidateProfile) => (o.kind === "music" || pick.kind === "music") && work(o) === work(pick);
  const rivals = others
    .filter((o) => o.page !== pick.page && !/\((?:disambiguation)\)$|^list of /i.test(o.page) && sameName(o, pick) && !oneWork(o))
    .map((o) => scoreCandidate(req, o))
    .sort((a, b) => b.points - a.points);
  const runnerUp = rivals[0] ?? null;
  const ahead = runnerUp ? top.points - runnerUp.points : Infinity;
  // Facts are held back on evidence only: a feature against the article, or a rival of its name too close behind.
  // An article the words can't place (a kind no word tells, a title spelled its own way) stays as the rules found it.
  const against = top.parts.some(([, p]) => p < 0) || ahead < MARGIN;
  const decision: Decision = (top.points >= SURE || !against) && ahead >= MARGIN ? "sure" : top.points >= DATA_ONLY ? "data-only" : "abstain";
  return { decision, top, runnerUp, target: { page: pick.page, kind: pick.kind, year: pick.year }, request: req };
}

/** One log line: the decision, each feature's points and the closest rival. Never a fact's words. */
export function matchLine(m: MatchResult, title: string): string {
  const parts = m.top.parts.map(([n, p]) => `${n} ${p > 0 ? "+" : ""}${p}`).join(", ");
  const rival = m.runnerUp ? `; same name "${m.runnerUp.page}" ${m.runnerUp.points}` : "";
  return `[Grounding] match: ${m.decision} ${m.top.points} for "${title}" on "${m.top.page}" (${parts || "no features"}${rival})`;
}

/** A data fact that holds for every version and recording of a work: who wrote or composed it, and nothing dated. */
export function holdsForEveryVersion(fact: string): boolean {
  return /\bwas (?:co-)?(?:written|composed) by\b/.test(fact) && !YEAR.test(fact) && !/\bcame out\b|\breleased\b|\bon the album\b/.test(fact);
}

// --- Facts against the target (MATCH=scored) ---------------------------------

/**
 * A data fact's year against the version the request names: "Some Song came out in 2010" for
 * "Some Song (1987)" is a reissue or another recording. The year is the request's, never the
 * article's, which may date the first recording of a song a later artist made famous.
 */
export function dataFitsTarget(fact: string, req: RequestProfile): boolean {
  const m = /\b(?:came out|was released) in (1[89]\d\d|20\d\d)\b/.exec(fact);
  return !m || !req.year || Math.abs(Number(m[1]) - req.year) <= 1;
}

/** Words a work's own name can carry that make it no other work: its series, its soundtrack albums, its editions. */
const SAME_WORK = new Set([
  ...["series", "franchise", "soundtrack", "original", "music", "video", "game", "games", "ost", "score", "s", "sound", "version", "tracks", "plus", "collection", "collections", "album", "box", "vol", "volume", "arrange"],
  ...[...EDITION.source.matchAll(/\w+/g)].map((m) => m[0]),
]);
/** Kinds of work that have sequels, remakes and sister works of a shared name. */
const SERIAL: WorkKind[] = ["game", "film", "tv", "series", "music", "album", "book", "stage"];
/** The name a caption opens with, in capitals: "Super Some Game II won", "Some Game: Other Part was". */
const OPENING_NAME = /^(?:[\p{Lu}\d][\p{L}\d'’.!-]*:?)(?:\s+(?:(?:of|the|no|de)\s+)*[\p{Lu}\d][\p{L}\d'’.!-]*:?)*/u;
/** Opening words that count or point, not name: "Many Some Games", "Its Some Game port". */
const DETERMINER = new Set(["many", "most", "all", "some", "several", "both", "each", "every", "other", "its", "his", "her", "their", "this", "these", "those", "early", "later", "later", "sales", "fans", "critics"]);

/**
 * A caption about another work than the target: one that opens on a sister work, whose name has
 * the target's whole name and more ("Super Some Game won", "Some Game II sold"), or on a remake
 * it leaves unnamed ("Remake won"). It holds true of the article, not of the song. A caption that
 * only mentions a sequel ("Some Game was followed by Some Game II") is about the target and stays.
 */
export function aboutAnotherWork(caption: string, req: RequestProfile, target: { page: string; kind: WorkKind }): boolean {
  const asked = new Set(tokens(`${req.piece} ${req.field} ${req.hint}`));
  if (/^(?:the )?remake\b/i.test(caption) && !/remake/i.test(`${req.piece} ${req.field} ${target.page}`)) return true;
  if (!SERIAL.includes(target.kind)) return false;
  const base = withoutQualifier(target.page);
  const work = tokens(target.kind === "music" ? musicOf(base) : base);
  const opening = OPENING_NAME.exec(caption)?.[0] ?? "";
  const name = tokens(opening).filter((t) => t !== "s");
  const at = name.findIndex((_, i) => work.every((t, j) => name[i + j] === t));
  if (!work.length || at < 0) return false;
  // "Sales of Some Game", "The music of Some Game": the work itself, after a word about it.
  if (at > 0 && new RegExp(`\\b(?:of|the|no|de)\\s+${work[0]}`, "i").test(normalizeTitle(opening).replace(/^the /, "").replace(/\b(?:i|ii|iii|iv|v|vi|vii|viii|ix|x)\b/g, (r) => ROMAN[r] ?? r))) return false;
  const more = name.filter((t, i) => (i < at || i >= at + work.length) && !SAME_WORK.has(t) && !asked.has(t) && !DETERMINER.has(t));
  // One-word names ("Some") take a number or numeral only: "Some 2", not "Some Records".
  return more.length > 0 && (work.length > 1 || more.every((t) => /^\d+$/.test(t)));
}

/**
 * The scored decision from a reference alone, as the lookup returns it (its page, then its text),
 * and the whole article when it was read (`full`): no summary, credit or search results. For
 * checks that have nothing more, such as tests.
 */
export function referenceDecision(asked: SSLSong, grounding: string, read: SSLSong = asked, full = ""): MatchResult {
  const page = grounding.split("\n")[0];
  return resolveWork(requestProfile(asked, read), candidateProfile(page, full || grounding.slice(page.length + 1)));
}

/** The rules' match once the score has its say (MATCH=scored): never surer than the rules. */
export function scoredLevel(rules: WorkMatch, m: MatchResult): WorkMatch {
  if (rules.level !== "sure" || m.decision === "sure") return rules;
  return { level: "unsure", reason: `the scored match is ${m.decision === "abstain" ? "too low to show anything" : "not sure"} (${m.top.points})` };
}

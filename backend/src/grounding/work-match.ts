import type { SSLSong } from "../types";
import { artistNames, dropVersionTags, mentionsName, normalizeTitle, resolveGameAndTrack } from "./titles";
import { initialsDiffer, PERFORMER_QUALIFIER, qualifierOf, significantTokens, withoutQualifier } from "./relevance";
import { articleText, isPieceArticle, openingSays } from "./covers";
import { namesPiece, SCREEN_OR_BOOK } from "./summary";
import { editDistance, isRespelling } from "./readings";

/**
 * Whether the article is about the requested work (issue #255):
 * `workMatchConfidence` and the article-kind checks it uses.
 */

// --- Is the article about the requested work? ----------------------------

/**
 * How sure the lookup is that its article is about the requested work
 * (issue #255): `sure`, `unsure` with the reason, or `none` with no article.
 * An unsure article gets no AI captions: a sequel, a series, a film named like
 * the band or the original of a cover gives true captions about the wrong thing.
 */
export interface WorkMatch {
  level: "sure" | "unsure" | "none";
  reason: string;
}

/** Pages reached through MusicBrainz's link rather than a Wikipedia search (issue #245). */
export const linkedPages = new Set<string>();

const SERIES_WORD = /\b(series|franchise)\b/i;
const AN_ALBUM = /\b(album|EP|mixtape|compilation)s?\b/i;
/** A film about a performer, whose lead reads like the performer's: "a 1988 short film about the singer...", not "a film composer". */
const A_FILM_ABOUT = /\b(?:film|movie|documentary|miniseries|novel)\b(?: (?:about|directed|written|based|starring|that)\b|[,.]|$)/i;

/** The first `n` sentences of an article's lead. */
function leadSentences(full: string, n: number): string {
  const lead = full.split(/\n==/)[0].replace(/\s+/g, " ").trim();
  const ends = [...lead.matchAll(/[.!?](?=\s+[\p{Lu}"“(])/gu)].map((m) => (m.index ?? 0) + 1);
  return ends.length >= n ? lead.slice(0, ends[n - 1]) : lead;
}

/** Whether normalized text names one of these, spelled a letter or two differently ("Colbie Cailat"). */
export function namesLoosely(text: string, names: string[]): boolean {
  if (mentionsName(text, names)) return true;
  const words = text.split(" ");
  return names.some((name) => {
    const want = name.replace(/ /g, "");
    const n = name.split(" ").length;
    if (want.length < 5) return false;
    for (let size = Math.max(1, n - 1); size <= n + 1; size++) {
      for (let i = 0; i + size <= words.length; i++) {
        const got = words.slice(i, i + size).join("");
        if (initialsDiffer(words.slice(i, i + size).join(" "), name)) continue;
        if (Math.abs(got.length - want.length) <= 2 && editDistance(got, want) <= Math.max(1, Math.floor(want.length * 0.15))) return true;
      }
    }
    return false;
  });
}

/**
 * `song` is the reading that found the reference; `asked` is the request as typed.
 * - `sure`: the song's own article naming its artist up front; a game's own article
 *   or its music article (the expected unit for a game's track); the artist's article
 *   that names the song, or that was found under the name as typed.
 * - `unsure`: the original of a cover; MusicBrainz's link to the artist; an album's
 *   article for a song; a song article that doesn't name the artist up front (only
 *   its first sentence counts for a short title, "Cherry"); a game's parent article
 *   for an edition or epilogue; a series' article, or its music article, for a track
 *   it never names; a film's, a show's or a book's article that never names the song,
 *   or one named after the artist; the artist's article that never names the song,
 *   found only after dropping a note ("Some Singer (Tribute)", "Song (X cover)").
 */
export function workMatchConfidence(song: SSLSong, grounding: string, asked: SSLSong = song): WorkMatch {
  if (!grounding.trim()) return { level: "none", reason: "no article" };
  const unsure = (reason: string): WorkMatch => ({ level: "unsure", reason });
  const sure = (reason: string): WorkMatch => ({ level: "sure", reason });
  const page = grounding.split("\n")[0];
  const full = articleText(page) || grounding.slice(page.length + 1);
  const base = withoutQualifier(page);
  const qualifier = qualifierOf(page) ?? "";
  const says = openingSays(full);
  const { game, track } = resolveGameAndTrack(song);
  const piece = track && normalizeTitle(track) !== normalizeTitle(game) ? track : "";
  const names = [...new Set([...artistNames(song.artist ?? ""), ...artistNames(asked.artist ?? "")])];
  // As music: "Castlevania" names the "Vampire Killer" whip, and "Punch-Out!!" a character's training.
  const named = Boolean(piece) && (/^About this piece:/m.test(grounding) || namesPiece(full, piece));
  // A note the lookup dropped: in brackets after the artist ("Some Singer (Tribute)"), or a cover's in the title.
  const noted = /\([^)]*\)\s*$/.test(asked.artist ?? "") || /[([][^)\]]*\bcover\b[^)\]]*[)\]]/i.test(asked.title);

  if (/^About this piece: .* is originally by .*\bcover\b/m.test(grounding)) return unsure("the article is about the original of a cover");
  if (linkedPages.has(page) && isPerformerArticle(page, full)) return unsure("MusicBrainz's link led to the artist's article, not the song's");
  // A classical piece found through its Wikidata item (issue #260): its own article, or its parent work's.
  const classical = classicalPages.get(classicalKey(page, asked.title)) ?? classicalPages.get(classicalKey(page, song.title));
  if (classical) {
    if (classical.section === null) return sure("the piece's own article, through its Wikidata item");
    return classical.section ? sure("the parent work's article, with a section on the piece") : unsure("the parent work's article has no section on the piece");
  }

  // The song's own article, by its title.
  const own = piece && (normalizeTitle(base) === normalizeTitle(piece) || isRespelling(piece, base) || aboutThePiece(page, full, piece));
  // "Walk This Way" for "Walk This Way - feat. A Guest": a song's article under part of the title.
  const partOf = piece && !own && isPieceArticle(page, full) && significantTokens(normalizeTitle(base)).length >= 2 &&
    mentionsName(`${normalizeTitle(piece)} ${normalizeTitle(dropVersionTags(asked.title))}`, [normalizeTitle(base)]);
  if (own || partOf) {
    if ((AN_ALBUM.test(qualifier) || AN_ALBUM.test(says)) && !/\bsoundtrack\b/i.test(qualifier + says)) return unsure(`"${page}" is an album's article, not the song's`);
    const short = significantTokens(normalizeTitle(piece)).length <= 1;
    const upFront = normalizeTitle(`${qualifier} ${leadSentences(full, short ? 1 : 3)}`);
    // A game's track: its own article names the game, the way a song's names its artist.
    if (!namesLoosely(upFront, names)) return unsure(`the song's article never names ${asked.artist || song.artist} up front${short ? " (a short title)" : ""}`);
    return sure("the song's own article");
  }

  // A game's music article ("Music of X", "X Soundtrack"): the expected unit for its tracks.
  // A series-wide one counts too, even when it never names the track: its facts are about the music.
  if (/^Music of /i.test(page) || /\bsoundtrack\b/i.test(`${qualifier} ${page}`)) {
    const seriesWide = (/\bseries$/i.test(base) || SERIES_WORD.test(says)) && !SERIES_WORD.test(asked.artist ?? "");
    return sure(seriesWide ? "the series' music article" : "the game's music article");
  }
  // Another piece's article: "Song B" for "Song A".
  if (piece && isPieceArticle(page, full)) return unsure(`"${page}" is another piece's article`);

  // The artist's article.
  const theArtist = !isNonMusicWork(page, full) && !A_FILM_ABOUT.test(says) && (isPerformerArticle(page, full) || (names.includes(normalizeTitle(base)) && !isWorkArticle(page, full)));
  if (theArtist) {
    if (piece && !named && noted) return unsure("the artist's article never names the song, and was found only after dropping a note");
    return sure(named ? "the artist's article names the song" : "the artist's article");
  }

  // A game's, a film's or a show's article.
  const work = significantTokens(normalizeTitle(game));
  const title = significantTokens(normalizeTitle(base));
  const startsWith = (long: string[], short: string[]) => long.length > short.length && short.every((t, i) => long[i] === t);
  // "Xenoblade Chronicles: Future Connected" from "Xenoblade Chronicles": the parent, unless its first sentence names the rest.
  if (startsWith(work, title)) {
    const rest = work.slice(title.length).join(" ");
    if (!mentionsName(significantTokens(normalizeTitle(leadSentences(full, 1))).join(" "), [rest])) return unsure(`the article is about ${base}, not ${game}`);
  }
  // "Orbit: Reforged", "a remake of Orbit: First Light", for a track of the first game: the remake's dates, platforms and makers aren't the game's.
  if (work.length && !work.every((t) => title.includes(t)) && /\b(?:remake|reboot|remaster|sequel|spin-?off) of\b/i.test(leadSentences(full, 2)) && mentionsName(normalizeTitle(leadSentences(full, 2)), [normalizeTitle(game)])) return unsure(`"${page}" is a remake or sequel of ${game}`);
  // "Depeche Mode: M" for a Depeche Mode song: another work named after the artist.
  if (piece && !named && startsWith(title, work) && !SERIES_WORD.test(game)) return unsure(`"${page}" is another work named after ${game}`);
  if (piece && !named && SERIES_WORD.test(says) && !SERIES_WORD.test(asked.artist ?? "")) return unsure("a series' article for one game's track, which it never names");
  const kind = (SCREEN_OR_BOOK.exec(qualifier) ?? (/\bgames?\b/i.test(says) ? null : SCREEN_OR_BOOK.exec(says)))?.[0];
  if (piece && !named && kind && !SCREEN_OR_BOOK.test(asked.artist ?? "")) return unsure(`a ${kind.toLowerCase()}'s article that never names the song`);
  // "Superstar: The Karen Carpenter Story" for the Carpenters' song, "Beverly Hills Cop: Axel F" for the theme: a film that
  // uses the name, not where the song comes from. Its article is about the film, even though it names the song.
  if (piece && kind && !title.every((t) => work.includes(t)) && (!work.every((t) => title.includes(t)) || startsWith(title, work))) return unsure(`"${page}" is a ${kind.toLowerCase()}'s article, not the song's`);
  return sure("the work's own article");
}

/** Whether a page is a piece of music's own article under another spelling of its title. */
function aboutThePiece(page: string, full: string, piece: string): boolean {
  const base = normalizeTitle(withoutQualifier(page));
  const want = normalizeTitle(piece);
  if (!want || !isPieceArticle(page, full)) return false;
  // Under another name: "Song (also known as Another Song) is a song by...".
  if (mentionsName(normalizeTitle(leadSentences(full, 2)), [want])) return true;
  return editDistance(base.replace(/ /g, ""), want.replace(/ /g, "")) <= Math.max(1, Math.floor(want.length * 0.15));
}


/**
 * Articles found for a classical piece through its Wikidata item, by page and
 * request: its own (`section` null), or its parent work's, with or without a
 * section about the piece. `workMatchConfidence` reads it.
 */
export const classicalPages = new Map<string, { section: boolean | null }>();
export const classicalKey = (page: string, title: string) => `${page}\0${normalizeTitle(dropVersionTags(title))}`;

/** What a game, a film or a show is called in its article's first sentence or its title's brackets. */
const WORK_WORDS =
  /\b(video games?|games?|films?|movies?|television (?:series|programs?|programmes?|shows?|films?)|tv series|animated series|anime|web series|sitcom|musical|soundtrack|franchise|series)\b/i;

/** Who or what else an article opens by naming: "a German film score composer", "a Middle Eastern folk tale". */
const NOT_WORK_WORDS =
  /\b(singer|band|composer|musician|rapper|songwriter|producer|actor|actress|director|DJ|duo|group|orchestra|person|character|company|developer|publisher|studio|label|tale|song|single|album|EP)s?\b/i;

/**
 * Whether an article is about a game, a film or a show: by its brackets, or
 * by what its first sentence says it is ("a 1997 role-playing video game"),
 * up to who made it.
 */
export function isWorkArticle(page: string, full: string): boolean {
  const qualifier = qualifierOf(page);
  if (qualifier) return WORK_WORDS.test(qualifier) && !NOT_WORK_WORDS.test(qualifier.replace(/\bsoundtrack album\b/i, "soundtrack"));
  const what = openingSays(full);
  return WORK_WORDS.test(what) && !NOT_WORK_WORDS.test(what.replace(/\bsoundtrack album\b/i, "soundtrack"));
}

/**
 * What a performer is called in an article's first sentence. The three performer lists differ by where
 * they look: PERFORMER_QUALIFIER reads a title's brackets, PERFORMER_LEAD an article's opening, where a
 * recording counts too, and this one only what the first sentence says the subject is.
 */
export const PERFORMER_WORDS =
  /\b(singers?|bands?|rappers?|musicians?|composers?|songwriters?|producers?|DJs?|disc jockeys?|duo|trio|group|vocalists?|pianists?|guitarists?|drummers?|violinists?|saxophonists?|orchestra|ensemble|choir|entertainers?|performers?|YouTuber)\b/i;

/**
 * Whether an article is about a performer: by its brackets ("(band)"), or by
 * what its first sentence says ("an American singer"). "Black Caviar" is a
 * duo's name and a racehorse's article.
 */
export function isPerformerArticle(page: string, full: string): boolean {
  const qualifier = qualifierOf(page);
  if (qualifier) return PERFORMER_QUALIFIER.test(qualifier);
  return PERFORMER_WORDS.test(openingSays(full));
}
/** Works that aren't music: a film, a show, a book, a play, a tale, a character. */
export const NON_MUSIC_WORK =
  /\b(films?|movies?|television|TV|miniseries|sitcoms?|soap operas?|web series|anime|novels?|novellas?|books?|plays?|short stor(?:y|ies)|comics?|manga|fairy tales?|folk tales?|tales?|poems?|paintings?|characters?)\b/i;
/** What makes an article about music or a game after all: "(Some Band song)", "a 1990 single", "a video game". */
const MUSIC_OR_GAME_WORK =
  /\b(songs?|singles?|albums?|EPs?|soundtracks?|bands?|singers?|rappers?|musicians?|groups?|duo|operas?|video games?|games?)\b/i;

/**
 * Whether an article is about a film, a show, a book, a play or another
 * work that isn't music or a game, by its brackets ("(1963 film)") or its
 * first sentence ("is a 1950 American animated musical fantasy film").
 */
export function isNonMusicWork(page: string, full: string): boolean {
  const qualifier = /\(([^)]*)\)\s*$/.exec(page)?.[1];
  const what = qualifier ?? openingSays(full);
  return NON_MUSIC_WORK.test(what) && !MUSIC_OR_GAME_WORK.test(what);
}

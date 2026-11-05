import { config } from "../config";
import type { SSLSong } from "../types";
import { blockedArticles } from "../wrong-facts";
import { hasNoArtist, withoutRequestCredit } from "../text";
import { setCapped } from "../capped-map";
import { linkedGrounding } from "../musicbrainz";
import { clearClassicalCache, placeOrTeam } from "../wikidata";
import { MAX_CONTEXT_CHARS, MIN_CONTEXT_CHARS } from "../fact-limits";
import { artistNames, type ClassicalTitle, mentionsName, normalizeTitle } from "./titles";
import { editionNotInTitle, isRelevantArticle, looksLikeArtistName, NOT_A_PERFORMER, PERFORMER_LEAD, qualifierNamesAnotherArtist, qualifierOf, significantTokens } from "./relevance";
import { olderVersionFailures, orderExtract, RateLimited, searchTerms, wikiExtract, wikiResolveTitles, wikiSearch } from "./wikipedia";
import { seriesFilter, withoutSentences } from "./sections";
import { otherWorkScope, wikitextCache, workScopeCache } from "./work-scope";
import { gameArticles, type GameArticles, isCoverOf, isPieceArticle, isPlaceholderRequest, openingSays, originalsRecord, otherVersionsRecord, writingText } from "./covers";
import { findMusicArticle, GAME_LEAD, gameInsteadOfScreen, gameTrackText, GENERIC_TRACK, isScreenPage, isSeriesWide, MAX_GAME_ARTICLES, namesPiece, noOwnArticle, oneOfSeveral, seriesScope, summaries } from "./summary";
import { type Grounded, groundingCache, groundSongAlone, lookupForm, MAX_GROUNDING, ownArticleExtract, type Reading, readings, seriesPage, wikipediaName, wikipediaNames } from "./readings";
import { classicalPages, isPerformerArticle, isWorkArticle, linkedPages } from "./work-match";
import { classicalAsk, classicalGrounding, notForAPiece } from "./classical-works";
import { cachedGrounding, companionCache, companionLine } from "./companion";
import { isConcertFilm, performerArticle, performerPagesCache, trackOwnArticle } from "./performer-name";
import { themeCache, themeGrounding } from "./theme";

/**
 * Grounding's entry point: `fetchGrounding` finds the reference text for a
 * song, trying each reading of the request, its classical work or its theme.
 */

/**
 * Reference text for the song, or "" when no relevant article exists.
 * `skip`: articles already found not to fit this request (`articleMisfit`), passed over like blocked ones.
 * When an article's older version couldn't be read on the way, Wikipedia is skipped for the song this
 * time (issue #242): data facts show instead, and the lookup is tried again later.
 */
export async function fetchGrounding(listed: SSLSong, skip: ReadonlySet<string> = new Set()): Promise<string> {
  // Who asked or paid for the song is never searched: "Some Band, Commissioned by Name" is Some Band.
  const title = withoutRequestCredit(listed.title) || listed.title;
  const artist = withoutRequestCredit(listed.artist ?? "", true);
  const song = title === listed.title.trim() && artist === (listed.artist ?? "").trim() ? listed : { ...listed, title, artist };
  const failedBefore = olderVersionFailures;
  const text = await findGrounding(song, skip);
  if (olderVersionFailures === failedBefore) return text;
  console.log(`[Grounding] "${song.title}": an article's older version couldn't be read, skipping Wikipedia for now`);
  return "";
}

async function findGrounding(song: SSLSong, skip: ReadonlySet<string>): Promise<string> {
  // Articles the streamer marked wrong for this song are never used for it again.
  const blocked = new Set([...blockedArticles(song), ...skip]);
  const usable = (title: string) => !blocked.has(title);
  const tried = new Set<string>();
  const attempt = async (reading: Reading): Promise<Grounded> => {
    const key = `${reading.songAlone ? "alone" : ""}${reading.trackOnly ? "track" : ""}${reading.cleaned ? "cleaned" : ""}\0${normalizeTitle(reading.game)}\0${normalizeTitle(reading.track)}`;
    if (tried.has(key)) return { text: "", unreachable: false };
    tried.add(key);
    if (tried.size > 1) console.log(`[Grounding] "${song.title}": trying ${reading.songAlone ? "the title alone" : `"${reading.track}" from "${reading.game}"`}`);
    return reading.songAlone ? groundSongAlone(song, reading.track, usable) : groundReading(song, reading, blocked);
  };
  // A classical piece: its work through Wikidata first, so a nickname or a catalog number finds the piece's own article (issue #260).
  if (config.classicalLookup && !song.artistUncertain && !isPlaceholderRequest(song)) {
    const classical = await classicalGrounding(song, usable);
    if (classical.text) return classical.text;
  }
  // The list's text as written first; then, for notes and tags it carries, the same without them.
  const listed = readings(song);
  const stripped = lookupForm(song);
  const same = (a: Reading, b: Reading) => a.game === b.game && a.track === b.track && !a.songAlone === !b.songAlone && !a.trackOnly === !b.trackOnly;
  const extra = stripped ? readings(stripped).filter((r) => !listed.some((l) => same(l, r))).map((r) => ({ ...r, cleaned: true })) : [];
  for (let reading of [...listed, ...extra]) {
    if (/ series$/.test(reading.game)) {
      try {
        const page = await seriesPage(reading.game.slice(0, -" series".length));
        if (page) reading = { ...reading, page };
      } catch (err) {
        if (err instanceof RateLimited) return "";
      }
    }
    const first = await attempt(reading);
    if (first.text || first.unreachable) return first.text;
    // Wikipedia's own name for what the request misspells or calls otherwise:
    // "Eric Satie" is "Erik Satie", "Star Wars: The Phantom Menace" is "Star Wars: Episode I – The Phantom Menace".
    if (reading.songAlone || reading.game.endsWith(" series") || song.performer || song.artistUncertain || !reading.game) continue;
    let { game, track } = reading;
    try {
      game = (await wikipediaName(game)) ?? game;
      // A piece by a composer or performer: "The Beautiful Blue Danube" is "The Blue Danube".
      if (track !== reading.game && looksLikeArtistName(game)) track = (await wikipediaName(track)) ?? track;
    } catch (err) {
      if (err instanceof RateLimited) return "";
      continue;
    }
    if (game === reading.game && track === reading.track) continue;
    // The renamed subject is the very page Wikipedia gave, not whatever a search for it finds:
    // "Pirates of the Caribbean" is the franchise, not "Pirates of the Caribbean (video game)".
    const renamed = await attempt({ ...reading, game, track, page: game === reading.game ? reading.page : game });
    if (renamed.text || renamed.unreachable) return renamed.text;
  }
  // Every reading missed: the article MusicBrainz's own Wikidata link names, gated (issue #245).
  const linked = config.mbLink && !isPlaceholderRequest(song) && !hasNoArtist(song.artist) ? await linkedGrounding(song, usable) : "";
  if (linked) linkedPages.add(linked.split("\n")[0]);
  // Still nothing for "Some Name Theme": the article of what the theme is named for, gated.
  return linked || (isPlaceholderRequest(song) ? "" : await themeGrounding(song, usable));
}

/** What to search Wikipedia for, in order, for one reading of the request. */
function groundingTerms(song: SSLSong, reading: Reading, artist: boolean): string[] {
  const { game, track } = reading;
  const terms = song.artistUncertain && track !== game
    ? [track]
    : searchTerms(game, track, artist || !!song.performer, reading.notGame || reading.fromTitle);
  // The page Wikipedia named is searched for by its own title; a series also by its bare name ("Star Trek").
  const series = /^(.+) (?:series|franchise)$/i.exec(game)?.[1];
  for (const extra of [reading.page, series]) {
    if (extra && !terms.includes(extra)) terms.splice(terms.includes(game) ? terms.indexOf(game) : terms.length, 0, extra);
  }
  // A music video's artist may share a name with a game or film; ask for the performer.
  if (song.performer && !looksLikeArtistName(game) && game.trim()) {
    const at = terms.indexOf(game);
    terms.splice(at < 0 ? terms.length : at, 0, `${game} band`);
  }
  return terms;
}

/**
 * Why a search result doesn't fit this reading, or "" when it does. `byGame`: it matched as the
 * game's or artist's article, not the track's; `installment`: as a longer title than the game's.
 */
function pageMisfit(
  song: SSLSong,
  reading: Reading,
  page: string,
  full: string | null,
  how: { byGame: boolean; installment: boolean; names: string[]; classical: ClassicalTitle | null }
): string {
  if (!full) return "";
  const { game, track } = reading;
  const { byGame, installment, names, classical } = how;
  // An installment or spin-off is only right when it's the song's own game: it must name the track.
  // A generic name ("Main Theme") is in every installment's article, so it names none of them.
  // Its name alone isn't enough: "Castlevania: Belmont's Curse" names the "Vampire Killer" whip, not the track.
  if (installment && (GENERIC_TRACK.test(normalizeTitle(track)) || !namesPiece(full, track))) return `never names "${track}" as music`;
  // A performer's name alone can be an everyday word: "Milestone" is about road markers.
  if (byGame && song.performer && !/\(/.test(page) && !PERFORMER_LEAD.test(full.slice(0, 400))) return "isn't about a performer";
  // One of several names may be anything: its own article must be a performer's ("Black Caviar" is a racehorse too),
  // A game's or a show's own article under that very name serves too: "Kingdom Hearts / Some Remixer".
  const workByName = () => !/\(/.test(page) && normalizeTitle(page) === normalizeTitle(game) && isWorkArticle(page, full);
  if (byGame && reading.aPerformer && !isPerformerArticle(page, full) && !workByName()) return "isn't about a performer";
  // A piece read from the title must be one: "Overwatch" read as a track name isn't "Overwatch and pornography".
  if (!byGame && reading.fromTitle && !isPieceArticle(page, full)) return "isn't about a piece of music";
  // A work read from the title must be a game, a film or a show: "Aladdin" is also a folk tale.
  if (byGame && reading.fromTitle && !isWorkArticle(page, full)) return "isn't a game, a film or a show";
  // "Passacaglia (Handel/Halvorsen)" names its composers in its title.
  const qualifier = qualifierOf(page) ?? "";
  if (!byGame && !mentionsName(`${normalizeTitle(full)} ${normalizeTitle(qualifier)}`, names)) return `never mentions "${game}"`;
  return classical ? notForAPiece(page, full, classical) : "";
}

/**
 * The part of an article to write from: the song's own article whole, or a game's or an artist's
 * cut to what's about the track. `ownArticle`: the article is the song's own (or the request is the game).
 */
function articleExtract(page: string, full: string | null, ownArticle: boolean, byGame: boolean, game: string, track: string): string {
  if (!full) return "";
  return ownArticle && !byGame
    ? ownArticleExtract(full, MAX_CONTEXT_CHARS - page.length - 1, [track, game])
    : orderExtract(full, MAX_CONTEXT_CHARS - page.length - 1, ownArticle ? [track, game] : [track], ownArticle);
}

/** The first of these articles that names the piece as music (`namesPiece`), reading at most three. */
async function namingPiece(titles: string[], track: string): Promise<string | null> {
  for (const t of titles.slice(0, 3)) {
    const full = await wikiExtract(t);
    if (full && namesPiece(full, track)) return t;
  }
  return null;
}

/** One reading of the request, looked up the usual way. */
async function groundReading(song: SSLSong, reading: Reading, blocked: Set<string>): Promise<Grounded> {
  const { game, track } = reading;
  // A subject pinned to one page is remembered apart: another song's search may have found another page for the name.
  // A lookup for the song's own article alone says nothing about the subject's article.
  const gameCacheKey = normalizeTitle(game) + (reading.page ? `\0${reading.page}` : "") + (reading.trackOnly ? "\0track" : "") + (reading.cleaned ? "\0cleaned" : "");
  const trackCacheKey = `${gameCacheKey}\0${normalizeTitle(track)}`;

  // A game's tracks share one lookup. An artist's songs never share: each may
  // have its own article. The artist test is a heuristic, and guessing
  // "artist" for a game only costs extra lookups, never wrong facts.
  // A music video's artist counts as one too (issue: "Muse - Starlight" must
  // search for Starlight, not reuse Muse's article cached for another song).
  const artist = looksLikeArtistName(game) || !!song.performer;
  const usable = (title: string) => !blocked.has(title);
  // A game's track with an article of its own ("Megalovania", "Baba Yetu") is
  // far richer than the game's article, so it's tried first: one search per
  // track, remembered either way (issue #48).
  // A generic name ("Theme") has no article of its own: "Theme from Star Trek" is another show's.
  const generic = GENERIC_TRACK.test(normalizeTitle(track));
  if (!artist && track && track !== game && !generic && !song.artistUncertain && !noOwnArticle.has(trackCacheKey) && !groundingCache.get(trackCacheKey)?.text) {
    const own = await trackOwnArticle(song, game, track, usable);
    if (own) {
      setCapped(groundingCache, trackCacheKey, { text: own, at: Date.now() }, MAX_GROUNDING);
      return { text: own, unreachable: false };
    }
    // Null when throttled or unreachable: the game's article below still serves, and this is tried again next time.
    if (own === "") noOwnArticle.add(trackCacheKey);
  }
  // The track's own article, found before.
  const ownHit = artist ? undefined : cachedGrounding(trackCacheKey, usable);
  if (ownHit) return { text: ownHit, unreachable: false };
  // A game already looked up: this track's reference is built from the kept articles.
  const kept = !song.performer && track !== game ? gameArticles.get(gameCacheKey) : undefined;
  if (kept && usable(kept.page)) {
    const drop = isPerformerArticle(kept.page, kept.full) ? null : await otherWorkScope([kept, kept.music], game);
    const text = withoutSentences(drop, !!track && track !== game && !generic, () => gameTrackText(kept, track, usable, game));
    setCapped(groundingCache, trackCacheKey, { text, at: Date.now() }, MAX_GROUNDING);
    return { text, unreachable: false };
  }
  // The game's reference or the track's, or a recent miss.
  for (const key of artist ? [trackCacheKey] : [gameCacheKey, trackCacheKey]) {
    const hit = key ? cachedGrounding(key, usable) : undefined;
    if (hit !== undefined) return { text: hit, unreachable: false };
  }

  // "Ecco the Dolphin CD" is the game "Ecco the Dolphin": an edition word isn't part of its name.
  const edition = game.replace(/\s+(?:CD|HD|DX|Remastered|Remaster|Deluxe|Definitive Edition|Complete Edition)$/i, "");
  // Which way an article matched decides how widely it may be shared. A
  // track article must not be attributed to another artist, and its text
  // must mention the game or artist: "Overture" alone is a generic article.
  const matchedGame = (title: string) =>
    // An artist that's only a guess from the uploader's channel is never looked up
    // as the subject: an uploader called "Apollo" isn't the god (issue from review).
    !song.artistUncertain &&
    // Only the piece's own article for a name that may be an arranger's or a fellow musician's.
    !reading.trackOnly &&
    // A film or a show is never a video game of the same name.
    !(reading.notGame && /\((?:[^)]*\b)?games?\b[^)]*\)\s*$/i.test(title)) &&
    // The page Wikipedia gave for the name, and only that one.
    (reading.page
      ? title === reading.page
      : isRelevantArticle(game, title, artist || !!song.performer) || (edition !== game && isRelevantArticle(edition, title, artist || !!song.performer))) &&
    // A music video's artist is a band or singer, never a game or film of the same name.
    !(song.performer && NOT_A_PERFORMER.test(title));
  // A longer title than the subject: "Final Fantasy" -> "Final Fantasy VII".
  const gameTokens = significantTokens(normalizeTitle(game)).length;
  const extendsGame = (title: string) => significantTokens(normalizeTitle(title)).length > gameTokens;
  const matchedTrack = (title: string) =>
    track !== game &&
    !generic && isRelevantArticle(track, title) && !qualifierNamesAnotherArtist(title, game, track);

  // "Lil Nas X, Jack Harlow": a song's article may name only its lead artist.
  const names = artistNames(game);
  const terms = groundingTerms(song, reading, artist);
  let unreachable = "";
  // A classical piece is never read from a film's, a show's or a non-musician's article, or another key's piece (issue #260).
  const classical = classicalAsk(song);

  for (const term of terms) {
    try {
      const titles = await wikiSearch(term);
      // For an artist, the song's own article beats the artist's, wherever it ranks:
      // "Industry Baby" over "Lil Nas X".
      // The same for a game's track that has an article of its own: "Megalovania" over "Undertale".
      // Among articles named for the track, the song's beats the album's: "Let It Be (song)" over "Let It Be (album)".
      const ofTrack = titles.filter((t) => usable(t) && matchedTrack(t));
      let page =
        ofTrack.find((t) => /\((?:[^)]*\b)?(song|composition|instrumental|theme)\)$/i.test(t)) ??
        ofTrack.find((t) => !/\((?:[^)]*\b)?(album|EP|soundtrack|film|musical)\)$/i.test(t)) ??
        ofTrack[0] ??
        // An edition's own article beats the original's: "Some Game Remake" over "Some Game".
        // One of several works of the name ("Some Game (1984 video game)") comes last.
        titles.find((t) => usable(t) && matchedGame(t) && !editionNotInTitle(game, t) && !oneOfSeveral(t, titles, game)) ??
        titles.find((t) => usable(t) && matchedGame(t) && !oneOfSeveral(t, titles, game)) ??
        titles.find((t) => usable(t) && matchedGame(t));
      if (!page) {
        if (titles.length) console.log(`[Grounding] No relevant match among: ${titles.join(", ")}`);
        continue;
      }
      // Several works share the name and the request doesn't say which: the one that names the piece as music, or none.
      const several = titles.filter((t) => usable(t) && matchedGame(t) && oneOfSeveral(t, titles, game) && normalizeTitle(t) === normalizeTitle(page));
      if (several.length && !matchedTrack(page) && track !== game && !generic) {
        const which = await namingPiece(several, track);
        if (which) page = which;
        else if (oneOfSeveral(page, titles, game)) {
          console.log(`[Grounding] "${page}" is one of several works named "${game}" and none names "${track}" as music, skipping`);
          continue;
        }
      }
      // A game's track: the game's own article over a film or a show of its name that never names the track,
      // from the search or, when it ranked lower, Wikipedia's pages for the name.
      if (!artist && !reading.notGame && !reading.page && !song.performer && track !== game && !generic && !matchedTrack(page) && isScreenPage(page) && !namesPiece((await wikiExtract(page)) ?? "", track)) {
        const fits = (t: string) => usable(t) && matchedGame(t) && !oneOfSeveral(t, titles, game);
        let ofGame = gameInsteadOfScreen(page, titles.filter(fits));
        if (!ofGame) {
          const named = await wikiResolveTitles([`${game} (video game)`, game]);
          ofGame = gameInsteadOfScreen(page, [...named.values()].filter((r) => !r.fragment).map((r) => r.page).filter(fits));
        }
        const lead = ofGame ? ((await wikiExtract(ofGame)) ?? "").slice(0, 600) : "";
        if (ofGame && (/game\)$/i.test(ofGame) || GAME_LEAD.test(lead))) {
          console.log(`[Grounding] "${page}" is another work that never names "${track}": the game's "${ofGame}" instead`);
          page = ofGame;
        }
      }
      let byGame = matchedGame(page);
      let full = await wikiExtract(page);
      let toPerformer = false;
      // Taken in place of the search's page: never read as a longer-named installment of the subject.
      let swapped = false;
      // A performer's song: its own article if Wikipedia has one, and never a film or a book that shares the name.
      if (byGame && full && track && track !== game && !generic && !reading.fromTitle && !reading.notGame && !song.artistUncertain) {
        const swap = await performerArticle(song, reading, page, full, usable);
        if (swap === "reject") {
          console.log(`[Grounding] "${page}" is a work that only shares the performer's name, skipping`);
          continue;
        }
        // The performer's own article stays when the song's is too short to write from.
        const songFull = swap && !swap.subject ? await wikiExtract(swap.page) : null;
        const tooShort = !!swap && !swap.subject && (!songFull || articleExtract(swap.page, songFull, true, false, game, track).length < MIN_CONTEXT_CHARS);
        if (swap && tooShort && isPerformerArticle(page, full)) {
          console.log(`[Grounding] "${swap.page}" is too short to write from: keeping the performer's article "${page}"`);
        } else if (swap) {
          const what = swap.music ? "the work's music article, which lists the track" : swap.subject ? "the performer's article" : "the song's own article";
          console.log(`[Grounding] "${page}" -> ${swap.page} (${what})`);
          page = swap.page;
          full = songFull ?? (await wikiExtract(page));
          byGame = swap.subject;
          toPerformer = swap.subject && !swap.music;
          swapped = true;
        }
      }
      // A concert film or documentary named for the song or the band is the film's article, not the song's.
      if (!byGame && full && artist && isConcertFilm(page, full)) {
        console.log(`[Grounding] "${page}" is a concert film or documentary that shares the song's name, skipping`);
        continue;
      }
      // A city, a country or a sports team named like the song or its artist ("Havana" the city): never
      // the song's, like a film that shares a band's name. Its Wikidata item says so; music and games aren't asked.
      const place = full && (isPieceArticle(page, full) || isPerformerArticle(page, full) || /\b(?:video )?games?\b/i.test(openingSays(full))) ? "" : await placeOrTeam(page);
      if (place) {
        console.log(`[Grounding] "${page}" is a place or a team (Wikidata: ${place}), not a work, skipping`);
        continue;
      }
      const installment = byGame && !swapped && extendsGame(page) && track !== game && !reading.page;
      const why = pageMisfit(song, reading, page, full, { byGame, installment, names, classical });
      if (why) {
        console.log(`[Grounding] "${page}" ${why}, skipping`);
        continue;
      }
      // The song's own article, or one about the whole game or artist?
      const ownArticle = !byGame || track === game || matchedTrack(page);
      const extract = articleExtract(page, full, ownArticle, byGame, game, track);
      if (extract.length < MIN_CONTEXT_CHARS) {
        console.log(`[Grounding] "${page}" is too short to write from (${extract.length} chars)`);
        continue;
      }
      // A series' music article found for one of its games: only what is about that game.
      const scoped = full && byGame && !ownArticle && seriesFilter.on && isSeriesWide(page, full, game) ? seriesScope(full, game, track) : "";
      // A game's or a work's article: not its sentences about a sequel, a remake or an edition.
      const ofWork = byGame && !ownArticle && !toPerformer && !song.performer && !!full && !isPerformerArticle(page, full);
      const saves = !!track && track !== game && !generic;
      const otherWork = ofWork ? await otherWorkScope([{ page, full: full! }], game) : null;
      // A cover's request read from the original's article: not the original's release, charts or video.
      const cover = !byGame && ownArticle && artist && !!full && isCoverOf(page, full, game, song.title);
      if (cover) console.log(`[Grounding] "${page}": the request is a cover; the original's release and charts left out`);
      const others = !cover && !byGame && ownArticle && artist && full ? otherVersionsRecord(full, game) : null;
      const drop = cover ? originalsRecord(full!, game) : others?.size ? new Set([...(otherWork ?? []), ...others]) : otherWork;
      // The song's own article with few words from its makers: more about it from its album's or its music's article (issue #48).
      // Not for a cover: the album would be the original's.
      const companion = !scoped && !cover && ownArticle && !byGame && full ? await companionLine(page, full, game, track, usable, !artist) : "";
      const budget = MAX_CONTEXT_CHARS - page.length - 1 - (companion ? companion.length + 2 : 0);
      let text = withoutSentences(drop, saves && !cover, () =>
        scoped
          ? `${page}\n${writingText(scoped, orderExtract(scoped, MAX_CONTEXT_CHARS - page.length - 1, [track], false), MAX_CONTEXT_CHARS - page.length - 1, [track])}`
          : companion
            ? `${page}\n${companion}\n\n${writingText(full!, ownArticleExtract(full!, budget, [track, game]), budget, [track, game])}`
            : `${page}\n${full ? writingText(full, extract, MAX_CONTEXT_CHARS - page.length - 1, ownArticle ? [track, game] : [track]) : extract}`
      );
      // "Chrono Trigger" and "Kingdom Hearts" read like people's names, so the article decides: is it a game's?
      const aGame = !artist || /game\)$/i.test(page) || GAME_LEAD.test(full?.slice(0, 600) ?? "");
      if (byGame && aGame && !swapped && !song.performer && !ownArticle && !installment && full) {
        let music: GameArticles["music"] = null;
        try {
          music = await findMusicArticle(game, usable);
        } catch {
          // Throttled or unreachable: the game's article serves on its own.
        }
        const articles = { page, full, music };
        // Shared by the game's tracks, unless this track has blocked articles of its own.
        if (!blocked.size) setCapped(gameArticles, gameCacheKey, articles, MAX_GAME_ARTICLES);
        const both = ofWork ? await otherWorkScope([articles, music], game) : null;
        text = withoutSentences(both, saves, () => gameTrackText(articles, track, usable, game));
        if (music) console.log(`[Grounding] "${game}" has a music article: ${music.page}${music.series ? " (series-wide: used for tracks it names)" : ""}`);
      }
      console.log(`[Grounding] "${song.title}" -> ${text.split("\n")[0]} (${text.length} chars)`);
      // Shared by the game's tracks, unless this track has blocked articles of its own.
      setCapped(groundingCache, byGame && !artist && !toPerformer && !blocked.size && !installment ? gameCacheKey : trackCacheKey, { text, at: Date.now() }, MAX_GROUNDING);
      return { text, unreachable: false };
    } catch (err) {
      unreachable = err instanceof RateLimited ? "rate-limited" : "lookup failed";
      if (!(err instanceof RateLimited)) {
        console.warn(`[Grounding] Lookup failed for "${term}": ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  console.log(
    `[Grounding] No reference for "${song.title}"` +
      (unreachable ? ` (${unreachable}, not cached)` : "") +
      ` — tried: ${terms.join(" | ")}`
  );
  // A miss caused by this song's blocked articles says nothing about the game's other tracks.
  if (!unreachable) setCapped(groundingCache, artist || blocked.size ? trackCacheKey : gameCacheKey, { text: "", at: Date.now() }, MAX_GROUNDING);
  return { text: "", unreachable: !!unreachable };
}

export function clearGroundingCache(): void {
  linkedPages.clear();
  themeCache.clear();
  summaries.clear();
  classicalPages.clear();
  clearClassicalCache();
  noOwnArticle.clear();
  companionCache.clear();
  wikitextCache.clear();
  workScopeCache.clear();
  performerPagesCache.clear();
  wikipediaNames.clear();
  gameArticles.clear();
  groundingCache.clear();
}

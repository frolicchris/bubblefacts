// Which article a song's captions are written from, and how sure it is the requested work (issue #226).
// The stream, the song list check and the Wrong replay call this one, so their article counts are the stream's
import { config } from "../config";
import type { SSLSong } from "../types";
import { readings } from "../list-profile";
import { musicbrainzFacts, statedYear, statesAlbum } from "../musicbrainz";
import { candidateProfile, matchLine, type MatchResult, requestProfile, resolveWork } from "../work-resolver";
import { artistNames, normalizeTitle } from "./titles";
import { withSearches } from "./wikipedia";
import { articleMisfit, articleText, isPlaceholderRequest } from "./covers";
import { pageSummary, summaryGate } from "./summary";
import { type WorkMatch, workMatchConfidence } from "./work-match";
import { fetchGrounding } from "./lookup";

const STREAMER_HANDLE = /(?:^|[\s(])@([A-Za-z0-9_]{3,25})\)?\s*$/;

/** A credit to another music content creator's channel ("Jane (@janeplayskeys)"): the @name, else undefined */
export const streamerHandle = (song: SSLSong): string | undefined => STREAMER_HANDLE.exec(song.artist ?? "")?.[1];

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

/** An article sure enough for its Wikidata item and the artist's good deeds: its title and the artists' names */
export interface SureArticle {
  page: string;
  names: string[];
}

const sureArticleOf = (song: SSLSong, read: SSLSong, context: string): SureArticle => ({
  page: context.split("\n")[0],
  names: [...new Set([...artistNames(song.artist ?? ""), ...artistNames(read.artist ?? "")])],
});

/** For its Wikidata item without an AI (#256): the AI reference's checks; null if none or unsure. Never throws */
export async function sureArticle(song: SSLSong): Promise<SureArticle | null> {
  try {
    const { context, read } = await findReference(song);
    if (!context || workMatchConfidence(read, context, song).level !== "sure" || (await summaryGate(read, context, song))) return null;
    return sureArticleOf(song, read, context);
  } catch (err) {
    console.warn(`[Grounding] Lookup for data facts failed for "${song.title}": ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// work-resolver.ts on what the lookup already read; unreadable = unknown. Never throws
async function scoreMatch(song: SSLSong, read: SSLSong, context: string, searchesSeen: () => readonly string[][]): Promise<MatchResult> {
  const page = context.split("\n")[0];
  const summary = await pageSummary(page).catch(() => null);
  const mb = await musicbrainzFacts(read);
  const credited = statedYear(mb) || statesAlbum(mb) ? true : null;
  const searches = searchesSeen();
  const rank = searches.some((s) => s[0] === page) ? 0 : -1;
  const pick = candidateProfile(page, articleText(page) || context.slice(page.length + 1), summary?.description ?? "", rank);
  const others = [...new Set(searches.flat())].filter((t) => t !== page).map((t) => candidateProfile(t));
  return resolveWork(requestProfile(song, read, credited), pick, others);
}

/** What `howSure` needs: the song, the reading that found the article, the article */
export type FoundArticle = {
  /** The request, without its bracket note */
  song: SSLSong;
  /** The reading of the song that found the article */
  read: SSLSong;
  /** The reference, its title on the first line; never "" */
  context: string;
  /** Every search result list the lookup saw (`withSearches`); read once the summary and MusicBrainz are in */
  searches: () => readonly string[][];
};

/** How sure the article is the requested work, and why */
export type Sureness = {
  /** "unsure": no AI captions, data facts only; "sure": the AI may write from it */
  level: "sure" | "unsure";
  /** Why it's unsure, as logged; "" when sure */
  why: string;
  /** The rules' match (workMatchConfidence, then summaryGate); null with ABSTAIN=off */
  match: WorkMatch | null;
  /** The scored match (#172); null with MATCH=rules */
  scored: MatchResult | null;
  /** MATCH=scored and the score isn't sure: only data true of every version */
  dataOnly: boolean;
  /** The article when the rules call it sure, for its Wikidata item (#256); else null */
  sure: SureArticle | null;
};

/** How sure: the rules, Wikipedia's summary, then the scored match. Logs the scored match and why it's unsure */
export async function howSure(found: FoundArticle): Promise<Sureness> {
  const { song, read, context } = found;
  // Unsure it's this song's article (#255): data facts only. Wikipedia's summary can say so too (disambiguation, a film)
  let match = config.abstain ? workMatchConfidence(read, context, song) : null;
  // Artist found by title alone: data facts at most
  if (song.artistFromTitle && match?.level !== "unsure") match = { level: "unsure", reason: "the artist was found by the title alone" };
  if (match?.level === "sure") {
    const why = await summaryGate(read, context, song);
    if (why) match = { level: "unsure", reason: why };
  }
  // Scored match (#172): shadow logs; scored holds back, never adds
  const scored = config.match !== "rules" ? await scoreMatch(song, read, context, found.searches) : null;
  if (scored) {
    console.log(matchLine(scored, song.title));
    const rules = match?.level === "unsure" ? "unsure" : "sure";
    if (config.match === "shadow" && (rules === "sure") !== (scored.decision === "sure")) console.log(`[Grounding] match differs: rules ${rules}, scored ${scored.decision} for "${song.title}"`);
  }
  // Score not sure: no captions, only data true of every version (who wrote it)
  const dataOnly = config.match === "scored" && Boolean(scored) && scored?.decision !== "sure";
  const sure = match?.level === "sure" ? sureArticleOf(song, read, context) : null;
  if (match?.level !== "unsure" && !dataOnly) return { level: "sure", why: "", match, scored, dataOnly, sure };
  const why = match?.level === "unsure" ? match.reason : scored?.decision === "abstain" ? `the article may be another work (${scored.top.points})` : "the scored match is not sure";
  console.log(`[Grounding] unsure: ${why} ("${context.split("\n")[0]}" for "${song.title}"), showing facts from data only`);
  return { level: "unsure", why, match, scored, dataOnly, sure };
}

/** The article and how sure, or why none was looked for */
export type Reference = { context: string; read: SSLSong; skipped: string } & Sureness;

const NOT_CHECKED: Sureness = { level: "sure", why: "", match: null, scored: null, dataOnly: false, sure: null };

/**
 * Which article the stream writes a song's captions from when an AI writes, and how sure: what the stream
 * decides, in its order (`findReference`, then `howSure`). `context` is "" for none; `skipped` says why none
 * was looked for (a placeholder, another creator's credit), else "". The stream calls the two steps apart
 */
export async function resolveReference(song: SSLSong): Promise<Reference> {
  const handle = streamerHandle(song);
  if (handle) return { context: "", read: song, skipped: `credited to a streamer (@${handle})`, ...NOT_CHECKED };
  if (isPlaceholderRequest(song)) return { context: "", read: song, skipped: "a request placeholder, not a song", ...NOT_CHECKED };
  const { found, searches } = await withSearches(() => findReference(song));
  const { context, read } = found;
  if (!context) return { context, read, skipped: "", ...NOT_CHECKED };
  return { context, read, skipped: "", ...(await howSure({ song, read, context, searches: () => searches })) };
}

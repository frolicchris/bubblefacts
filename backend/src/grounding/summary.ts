import { config } from "../config";
import type { SSLSong } from "../types";
import { blockedArticles } from "../wrong-facts";
import { anotherArtist } from "../musicbrainz";
import { MAX_CONTEXT_CHARS, MIN_CONTEXT_CHARS } from "../fact-limits";
import { artistNames, mentionsName, normalizeTitle, resolveGameAndTrack } from "./titles";
import { qualifierOf, significantTokens, withoutQualifier } from "./relevance";
import { brokenBySplit, MAX_ARTICLE_TEXTS, MUSIC_HEADING, orderExtract, RateLimited, USER_AGENT, wikiExtract, wikiSearch, withoutVideoSections } from "./wikipedia";
import { sectionExtract, sectionSelection, sectionSentences, seriesFilter, SKIP_HEADING } from "./sections";
import { articleText, type GameArticles, selectedText } from "./covers";

// Wikipedia's own page summary, and `summaryGate`, which keeps an article about the wrong work out

// Not a performer's song: "(1961 film)", "a concert documentary film"
export const SCREEN_OR_BOOK = /\b(film|movie|documentary|television|tv series|miniseries|sitcom|novel|manga|play)s?\b/i;

// --- Wikipedia's own summary of the article ---

/** Wikipedia's page summary (the REST endpoint page previews use): page kind, short description ("1975 song by Queen") */
export interface PageSummary {
  title: string;
  /** "standard" for an article; else "disambiguation", "no-extract" or "mainpage" */
  type: string;
  description: string;
  extract: string;
}

const SUMMARY_API = "https://en.wikipedia.org/api/rest_v1/page/summary/";
// Summaries read this session, by title (null: no such page)
export const summaries = new Map<string, PageSummary | null>();

/** A page's summary, or null for no such page; throws when unreadable */
export async function pageSummary(title: string): Promise<PageSummary | null> {
  if (summaries.has(title)) return summaries.get(title) ?? null;
  const res = await fetch(SUMMARY_API + encodeURIComponent(title.replace(/ /g, "_")), {
    signal: AbortSignal.timeout(config.groundingTimeoutMs),
    headers: { "User-Agent": USER_AGENT },
  });
  if (res.status === 429) throw new RateLimited("summary");
  if (!res.ok && res.status !== 404) throw new Error(`summary HTTP ${res.status}`);
  const data = res.ok ? ((await res.json()) as { title?: string; type?: string; description?: string; extract?: string }) : null;
  const summary = data ? { title: data.title ?? title, type: data.type ?? "", description: data.description ?? "", extract: data.extract ?? "" } : null;
  summaries.set(title, summary);
  if (summaries.size > MAX_ARTICLE_TEXTS) summaries.delete(summaries.keys().next().value as string);
  return summary;
}

/** What a short description calls its subject */
export type DescribedKind = "song" | "album" | "person" | "tv" | "book" | "series" | "game" | "film" | "other";
const DESCRIBED: Array<[DescribedKind, RegExp]> = [
  ["tv", /\b(?:(?:television|tv|anime|web|animated|streaming) (?:series|shows?|programmes?|programs?|films?|specials?)|sitcoms?|miniseries|television)\b/gi],
  ["book", /\b(?:(?:light )?novels?|novellas?|books?|manga(?: series)?|comics?|comic books?|graphic novels?|short stor(?:y|ies)|poems?|(?:novel|book|comic) series)\b/gi],
  ["series", /\b(?:series|franchise)\b/gi],
  ["game", /\b(?:video )?games?\b/gi],
  ["film", /\b(?:films?|movies?|documentar(?:y|ies))\b/gi],
  ["album", /\b(?:albums?|EPs?|mixtapes?|soundtracks?|scores?|compilations?|discograph(?:y|ies))\b/gi],
  ["song", /\b(?:songs?|singles?|instrumentals?|compositions?|hymns?|anthems?|arias?|ballads?|carols?|pieces?|sonatas?|symphon(?:y|ies)|concert[oi]s?|overtures?|nocturnes?|[eé]tudes?|preludes?|waltz(?:es)?|jingles?|themes?)\b/giu],
  ["person", /\b(?:bands?|singers?|singer-songwriters?|songwriters?|rappers?|musicians?|composers?|pianists?|guitarists?|drummers?|bassists?|violinists?|vocalists?|DJs?|disc jockeys?|producers?|groups?|duo|trio|quartet|orchestras?|ensembles?|choirs?|conductors?|actors?|actresses?|idols?|YouTubers?|entertainers?|performers?|artists?|lyricists?|arrangers?|people|person)\b/gi],
];
const DESCRIPTION_HEAD = /\s(?:by|from|of|for|in|on|at|about|featuring|directed|written|composed|created|developed|published|produced|released|recorded|performed|based|starring|with)\b|[,(;:]/i;

/**
 * The kind a short description names ("Japanese video game composer": a person): the kind word ending last
 * before "by", "from" or a comma; at the same place the longer wins ("television series" over "series")
 */
export function describedKind(description: string): DescribedKind {
  const head = description.split(DESCRIPTION_HEAD)[0];
  let best: { kind: DescribedKind; end: number; length: number } | null = null;
  for (const [kind, re] of DESCRIBED) {
    for (const m of head.matchAll(re)) {
      const end = (m.index ?? 0) + m[0].length;
      if (!best || end > best.end || (end === best.end && m[0].length > best.length)) best = { kind, end, length: m[0].length };
    }
  }
  return best?.kind ?? "other";
}

const SCREEN_KINDS = new Set<DescribedKind>(["film", "tv", "book", "game"]);

/** Why the summary says it isn't the requested work, or "" (ARCHITECTURE.md: choosing the article) */
export function summaryMismatch(summary: PageSummary | null, song: SSLSong, grounding: string, asked: SSLSong = song): string {
  if (!summary) return "";
  if (summary.type === "disambiguation") return "Wikipedia's summary calls it a disambiguation page";
  if (summary.type && summary.type !== "standard") return `Wikipedia's summary calls it a "${summary.type}" page, not an article`;
  const kind = describedKind(summary.description);
  const page = grounding.split("\n")[0];
  const base = normalizeTitle(withoutQualifier(page));
  const { game, track } = resolveGameAndTrack(song);
  const piece = track && normalizeTitle(track) !== normalizeTitle(game) ? normalizeTitle(track) : "";
  const described = `Wikipedia describes "${page}" as "${summary.description}"`;
  if (piece && base === piece && kind !== "song" && kind !== "other" && kind !== "series") return `${described}, not the song`;
  const actWhy = piece && base !== piece ? wrongActPage(summary, page, kind, [game, song.artist ?? "", asked.artist ?? ""], piece, grounding) : "";
  if (actWhy) return actWhy;
  if (!SCREEN_KINDS.has(kind)) return "";
  // The request's own work: its game or artist field, whole words ("Pokemon Red" in "Pokémon Red and Blue")
  const words = significantTokens(base);
  const own = [game, song.artist ?? "", asked.artist ?? ""].some((n) => {
    const want = significantTokens(normalizeTitle(n));
    return want.length > 0 && (want.every((t) => words.includes(t)) || (words.length > 0 && words.every((t) => want.includes(t))));
  });
  if (own || !piece) return "";
  const full = articleText(page) || grounding.slice(page.length + 1);
  if (/^About this piece:/m.test(grounding) || mentionsName(normalizeTitle(full), [piece])) return "";
  return `${described}, another work that never names the song`;
}

const bareName = (name: string) => name.replace(/^the /, "");

// Words in any order, no leading "the": "System-Pi" is "Pi-system"
const nameWords = (name: string) => [...new Set(bareName(normalizeTitle(name)).split(" ").filter(Boolean))].sort();

/**
 * Why an article under the artist's name is about something else, or "" (DJ check, 2026-10-31): not a
 * performer ("Ed209" found the robot "ED-209"), or a longer performer's name ("Jäger" found "Marike Jager")
 */
export function wrongActPage(summary: PageSummary, page: string, kind: DescribedKind, artists: string[], piece: string, grounding: string): string {
  const base = nameWords(withoutQualifier(page));
  if (!base.length) return "";
  const wanted = artists.flatMap((a) => artistNames(a)).map(nameWords).filter((w) => w.length);
  if (!wanted.length) return "";
  const same = wanted.some((w) => w.join(" ") === base.join(" "));
  const inside = !same && wanted.some((w) => w.length < base.length && w.every((t) => base.includes(t)));
  if (!(same && kind !== "person") && !(inside && kind === "person")) return "";
  // A game's soundtrack: the artist field is the game, and the game's own article is the right one
  // even when it never names the track ("Turtle Village" in "Golden Axe", 2026-11-08).
  if (same && kind === "game" && artists[0] && nameWords(artists[0]).join(" ") === base.join(" ")) return "";
  const full = articleText(page) || grounding.slice(page.length + 1);
  if (namesPiece(full, piece)) return "";
  const described = `Wikipedia describes "${page}" as "${summary.description}"`;
  return same ? `${described}, not a performer of that name` : `"${page}" only shares part of the artist's name`;
}

/**
 * Why the summary says it isn't the requested work, or "" (also when unreadable). A person's article loses to
 * the song's own ("Song (Some Band song)"); a same-name act MusicBrainz doesn't credit isn't the one
 */
export async function summaryGate(song: SSLSong, grounding: string, asked: SSLSong = song): Promise<string> {
  const page = grounding.split("\n")[0];
  try {
    const summary = await pageSummary(page);
    const why = summaryMismatch(summary, song, grounding, asked);
    if (why || !summary || describedKind(summary.description) !== "person") return why;
    const { game, track } = resolveGameAndTrack(song);
    if (!track || normalizeTitle(track) === normalizeTitle(game)) return "";
    const names = [...new Set([...artistNames(song.artist ?? ""), ...artistNames(asked.artist ?? "")])];
    const blocked = blockedArticles(asked);
    for (const title of [...new Set([`${track} (${withoutQualifier(page)} song)`, `${track} (song)`, track])]) {
      if (title === page) continue;
      const own = await pageSummary(title);
      if (!own || own.type !== "standard" || describedKind(own.description) !== "song" || blocked.has(own.title)) continue;
      if (mentionsName(normalizeTitle(`${own.description} ${own.extract}`), names)) return `the song has an article of its own ("${own.title}"), not "${page}"`;
    }
    // A band only sharing the name: the article never ties it to the song, and MusicBrainz credits someone else
    const full = articleText(page);
    if (full && !namesPiece(full, track) && names.map(bareName).includes(bareName(normalizeTitle(withoutQualifier(page)))) && (await anotherArtist(page, track, game))) return `MusicBrainz credits "${track}" to another ${game} than "${page}"`;
    return "";
  } catch {
    return "";
  }
}

// Game tracks found to have no article of their own
export const noOwnArticle = new Set<string>();
export const MAX_GAME_ARTICLES = 40;

// Too common to search for: every game has a "Title Theme"
export const GENERIC_TRACK = /^(opening|ending|theme|main theme|title|title theme|title screen|credits|intro|menu|boss|battle|overworld|prologue|epilogue|finale|stage \d+|level \d+|act \d+|\d+ ?[ap]m)$/i;
const MAX_TRACK_SENTENCES = 4;
const MAX_TRACK_CHARS = 800;

/** The sentences naming this track: the only ones certainly about it */
export function trackSentences(full: string, track: string): string[] {
  const name = normalizeTitle(track);
  if (name.length < 5 || GENERIC_TRACK.test(name)) return [];
  const kept: string[] = [];
  let used = 0;
  for (const raw of full.split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})|\n+/u)) {
    const text = raw.trim();
    if (text.length < 30 || text.length > 320 || /^=+/.test(text) || brokenBySplit(text)) continue;
    if (!mentionsName(normalizeTitle(text), [name])) continue;
    if (kept.length >= MAX_TRACK_SENTENCES || used + text.length > MAX_TRACK_CHARS) break;
    kept.push(text);
    used += text.length + 1;
  }
  return kept;
}

// A name in a sentence with one is a piece's, not a weapon's, a level's or an everyday word's
const MUSIC_CONTEXT =
  /\b(music\w*|songs?|singles?|tracks?|themes?|soundtracks?|scor(?:e|es|ed|ing)|compos\w*|melod(?:y|ies|ic)|tunes?|pieces?|albums?|arrange\w*|remix\w*|instrumentals?|lyrics?|sung|sings?|ballads?|anthems?|BGM|chart\w*)\b/i;

/** Whether a sentence about music names the piece: "from working alone" doesn't name Heart's "Alone" */
export function namesPiece(full: string, piece: string): boolean {
  const name = normalizeTitle(piece);
  if (!name || GENERIC_TRACK.test(name)) return false;
  return full.split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})|\n+/u).some((s) => MUSIC_CONTEXT.test(s) && mentionsName(normalizeTitle(s), [name]));
}

/** One of several same-name works told apart by a year the request lacks: "Punch-Out!! (1984 video game)" */
export function oneOfSeveral(title: string, titles: string[], game: string): boolean {
  const year = /\b(?:19|20)\d\d\b/.exec(qualifierOf(title) ?? "")?.[0];
  if (!year || game.includes(year)) return false;
  const base = normalizeTitle(title);
  return titles.some((t) => t !== title && normalizeTitle(t) === base);
}

// An opening about a game: "a 1992 platform game"
export const GAME_LEAD = /\b(video|role-playing|platform|action|adventure|puzzle|rhythm|fighting|racing|strategy|simulation)[- ](?:[\w-]+ )?games?\b/i;

/** A film's, show's or book's page by its brackets: "Some Game 2 (film)" */
export function isScreenPage(title: string): boolean {
  const q = qualifierOf(title);
  return !!q && SCREEN_OR_BOOK.test(q) && !/\bgames?\b/i.test(q);
}

/** The game's own page, bare or "(video game)", in place of a same-name film's, show's or book's (`page`) */
export function gameInsteadOfScreen(page: string, matches: string[]): string | null {
  if (!isScreenPage(page)) return null;
  return matches.find((t) => t !== page && /^(?:(?:video )?game)?$/i.test(qualifierOf(t) ?? "")) ?? null;
}

/** Whether a title is the music article for this game or its series */
export function isMusicArticleFor(title: string, game: string): boolean {
  const g = normalizeTitle(game);
  const of = /^Music of (?:the )?(.+?)(?: series)?$/i.exec(title);
  if (of) {
    const subject = normalizeTitle(of[1]);
    // The game, or its series: "Sonic the Hedgehog" for "Sonic the Hedgehog 3"
    return subject.length >= 2 && (g === subject || g.startsWith(`${subject} `));
  }
  const album = /^(.+?)(?: Original)? Soundtrack$|^(.+?) \(soundtrack\)$/i.exec(title);
  return Boolean(album && normalizeTitle(album[1] ?? album[2]) === g);
}

// About this very game, not its series
const isThisGames = (title: string, game: string) =>
  normalizeTitle(title.replace(/^Music of (?:the )?/i, "").replace(/ series$| (?:Original )?Soundtrack$| \(soundtrack\)$/i, "")) === normalizeTitle(game);

// After a game's name, makes it another game or the series: "Some Quest 2", "Some Quest series"
const ANOTHER_ENTRY = /^(?:\d+\w*|i{2,3}|iv|vi{0,3}|ix|x|series|franchise|games|video|media|universe|saga|collection|trilogy)$/;

/** Whether text names this game, not a sequel or series. `others`: normalized games starting with its name ("Some Quest Zero") */
export function namesThisGame(normalizedText: string, game: string, others: string[] = []): boolean {
  const g = normalizeTitle(game);
  if (!g) return false;
  const words = ` ${normalizedText} `;
  for (let at = words.indexOf(` ${g} `); at >= 0; at = words.indexOf(` ${g} `, at + 1)) {
    const after = words.slice(at + 1);
    const next = words.slice(at + g.length + 2).split(" ")[0];
    if (!ANOTHER_ENTRY.test(next) && !others.some((o) => after.startsWith(`${o} `))) return true;
  }
  return false;
}

// "The music for Some Studio's Some Quest video game series", not "composed by regular series composer"
const SERIES_MUSIC = /\b(?:music|soundtracks?|scores?|songs) (?:of|for|from) (?:(?:\p{Lu}[\p{L}\p{N}'’:&.-]*|\d+|the|video|game|media|and|of) ){0,8}(?:series|franchise)\b/u;

/**
 * Whether it's a whole series' music: named for another, a first sentence on a series, or 3+ "Game (1992)"
 * sections. The first game often shares the series' name, so the title can't tell
 */
export function isSeriesWide(page: string, full: string, game: string): boolean {
  const g = normalizeTitle(game);
  if (!g) return false;
  const named = /^Music of (?:the )?(.+?)(?: series)?$/i.exec(page)?.[1] ?? /^(.+?) (?:series|franchise)$/i.exec(page)?.[1];
  if (named && normalizeTitle(named) !== g) return true;
  if (!named && !/\b(soundtracks?|music|score)\b/i.test(page)) return false;
  const first = full.split(/(?<=[.!?])\s+/)[0] ?? "";
  if (SERIES_MUSIC.test(first)) return true;
  const perGame = new Set([...full.matchAll(/^==+\s*(.+?)\s*\(\d{4}\)\s*==+\s*$/gm)].map((m) => normalizeTitle(m[1])));
  return perGame.size >= 3;
}

/**
 * A series-wide music article cut to this game (ARCHITECTURE.md: `seriesScope`). Kept sections are
 * flattened to one level, so a game's section under "History" isn't read as narrative
 */
export function seriesScope(full: string, game: string, track: string): string {
  const g = normalizeTitle(game);
  const t = normalizeTitle(track);
  const trackNamed = t.length >= 5 && !GENERIC_TRACK.test(t);
  const [leadText, ...rest] = full.split(/\n(?===)/);
  // Other games starting with this one's name: "Some Quest Zero" for "Some Quest"
  const others = [...full.matchAll(/^==+\s*([^=\n]+?)\s*==+\s*$/gm)].map((m) => normalizeTitle(m[1])).filter((h) => h.startsWith(`${g} `));
  const keeps = (s: string) => namesThisGame(normalizeTitle(s), game, others) || (trackNamed && mentionsName(normalizeTitle(s), [t]));
  const lead = sectionSentences(leadText).filter(keeps);
  const parts: string[] = [];
  let kept = lead.length;
  const open: Array<{ level: number; ours: boolean }> = [];
  for (const chunk of rest) {
    const h = /^(==+)\s*([^=\n]+?)\s*==+\s*\n?([\s\S]*)$/.exec(chunk);
    if (!h) continue;
    const level = h[1].length;
    while (open.length && open[open.length - 1].level >= level) open.pop();
    const ours = normalizeTitle(h[2]) === g || Boolean(open[open.length - 1]?.ours);
    open.push({ level, ours });
    if (SKIP_HEADING.test(h[2].trim())) continue;
    const sentences = sectionSentences(h[3]).filter((s) => ours || keeps(s));
    if (!sentences.length) continue;
    kept += sentences.length;
    parts.push(`== ${h[2]} ==\n${sentences.join(" ")}`);
  }
  if (kept < 2) return leadText.trim();
  return [lead.join(" "), ...parts].filter(Boolean).join("\n\n");
}

/** The game's music article, or null; one search. A series-wide one is used only for tracks it names (`gameTrackText`) */
export async function findMusicArticle(game: string, usable: (title: string) => boolean): Promise<GameArticles["music"]> {
  const fits = (t: string) => usable(t) && isMusicArticleFor(t, game);
  let titles = (await wikiSearch(`Music of ${game}`)).filter(fits);
  if (!titles.length) titles = (await wikiSearch(`${game} soundtrack`)).filter(fits);
  // The game's own first, then the series-wide one
  for (const page of [...titles.filter((t) => isThisGames(t, game)), ...titles.filter((t) => !isThisGames(t, game))].slice(0, 2)) {
    const full = await wikiExtract(page);
    if (!full || full.length < MIN_CONTEXT_CHARS) continue;
    // "Sonic the Hedgehog (soundtrack)" is the 2020 film's album, not the game's
    const lead = full.slice(0, 500);
    if (/\b(film|movie|television series|TV series)\b/i.test(lead) && !/\bvideo games?\b/i.test(lead)) continue;
    return { page, full, series: !isThisGames(page, game) };
  }
  return null;
}

// Kinds of section, not names of a soundtrack's parts
export const GENERIC_SECTION =
  /^(?:background|development|composition|production|recording|releases?|reception|critical|commercial|legacy|references|notes|external|see also|track listings?|personnel|credits|charts?|certifications?|awards?|accolades|overview|history|music|soundtracks?|albums?|singles|eps|other|musicology|instrumentation|motifs?|themes?|style|influences?|bibliography|further|sales|live|concerts?|creation|concept|writing|lyrics|cast|plot|synopsis|gameplay|setting|story|characters|marketing|reviews?|impact|cover|versions?|remix(?:es)?|formats?|editions?|arrangements?)\b/i;

/** An article's sections: heading, level, and its lines, subsections included */
export function sectionsOf(lines: string[]): Array<{ heading: string; quoted: boolean; level: number; from: number; to: number }> {
  const heads = lines.flatMap((line, i) => {
    const h = /^(==+)\s*(.+?)\s*==+\s*$/.exec(line);
    const quoted = h ? /^["“].*["”]$/.test(h[2]) : false;
    return h ? [{ heading: h[2].replace(/^["“](.*)["”]$/, "$1"), quoted, level: h[1].length, from: i, to: lines.length }] : [];
  });
  for (const [n, h] of heads.entries()) {
    const next = heads.slice(n + 1).find((o) => o.level <= h.level);
    if (next) h.to = next.from;
  }
  return heads;
}

/**
 * The soundtrack part a track names ("Fontaine: Remuria"): the lead and that section, plus the other parts its
 * captions mustn't name. Null unless 2+ others. Unknown parts: `unknownPart` (ARCHITECTURE.md: `soundtrackPart`)
 */
export function soundtrackPart(full: string, track: string): { heading: string; text: string; others: string[] } | null {
  const lines = withoutVideoSections(full).split("\n");
  const parts = sectionsOf(lines).filter((s) => !GENERIC_SECTION.test(s.heading) && s.heading.split(/\s+/).length <= 5);
  const name = ` ${normalizeTitle(track)} `;
  const matched = parts
    .filter((s) => normalizeTitle(s.heading).length >= 4 && name.includes(` ${normalizeTitle(s.heading)} `))
    .sort((a, b) => b.heading.length - a.heading.length)[0];
  if (!matched) return unknownPart(lines, parts, track);
  // Not other parts: its own subsections, the sections it sits in, a quoted heading (one track any caption may name)
  const others = parts.filter((s) => !s.quoted && !(s.from >= matched.from && s.to <= matched.to) && !(s.from <= matched.from && s.to >= matched.to));
  if (others.length < 2) return null;
  const lead = lines.slice(0, lines.findIndex((l) => /^==/.test(l))).join("\n").trim();
  const section = lines.slice(matched.from, matched.to).join("\n");
  return { heading: matched.heading, text: `${lead}\n\n${section}`, others: [...new Set(others.map((s) => s.heading))] };
}

/** The lead and general sections, for a "Name: Title" track whose name the article never mentions: every part is another */
function unknownPart(lines: string[], parts: ReturnType<typeof sectionsOf>, track: string): { heading: string; text: string; others: string[] } | null {
  const prefix = /^([^:]{3,}):\s*\S/.exec(track)?.[1];
  const named = parts.filter((s) => !s.quoted);
  // Only a soundtrack in parts: a composer's article has sections too ("Sonata in A Major, K. 331: i. Andante")
  const lead = lines.slice(0, Math.max(0, lines.findIndex((l) => /^==/.test(l)))).join(" ");
  if (!prefix || !/\b(soundtracks?|score)\b/i.test(lead) || named.filter((s) => s.level === 2).length < 3) return null;
  if (mentionsName(normalizeTitle(lines.join(" ")), [normalizeTitle(prefix)])) return null;
  const text = lines.filter((_, i) => !named.some((s) => i >= s.from && i < s.to)).join("\n").trim();
  return { heading: "", text, others: [...new Set(named.map((s) => s.heading))] };
}

/** Other parts of the soundtrack a reference was cut from, which this track's captions mustn't name */
export function otherParts(text: string, track: string): string[] {
  const full = articleText(text.split("\n")[0]);
  return full ? (soundtrackPart(full, track)?.others ?? []) : [];
}

// Any section but a list of tracks, credits or references
export const NOT_A_LIST = /^(?!.*(track listing|personnel|credits|chart|certification|reference|external|see also|notes)).+$/i;
// In a music article, how it was made goes before lists of albums and releases
const MAKING_OF_MUSIC = /creation|development|concept|influence|composition|writing|recording|background|overview|production|style|themes/i;

/** One game track's reference: what names the track first, then the usual order; from the music article if any */
export function gameTrackText(a: GameArticles, track: string, usable: (title: string) => boolean = () => true, game = ""): string {
  const fits = a.music && usable(a.music.page) && (!a.music.series || trackSentences(a.music.full, track).length > 0);
  const fromMusic = Boolean(fits && a.music);
  let base = fits && a.music ? a.music : a;
  // A series-wide music article: only this game's part ("Music of Some Quest" for the first "Some Quest")
  const name = game || a.page.replace(/\s*\([^)]*\)\s*$/, "");
  if (seriesFilter.on && base.full && ((fromMusic && a.music?.series) || isSeriesWide(base.page, base.full, name))) {
    base = { ...base, full: seriesScope(base.full, name, track) };
  }
  // "Liyue: Relaxation in Liyue": the lead and the Liyue section, nothing about Mondstadt
  const part = soundtrackPart(base.full, track);
  const full = part ? part.text : withoutVideoSections(base.full);
  // Section-aware selection keeps a narrative section's sentence only when about the music;
  // only music sentences count: "Castlevania" names the MSX game and the whip "Vampire Killer" too
  const about = trackSentences(sectionSelection.on ? selectedText(full, [track]) : full, track).filter((s) => MUSIC_CONTEXT.test(s));
  const block = about.length ? `About this piece: ${about.join(" ")}\n\n` : "";
  const budget = MAX_CONTEXT_CHARS - base.page.length - 1 - block.length;
  const picked = sectionSelection.on ? sectionExtract(full, budget, [track], new Set(about)) : "";
  if (picked) return `${base.page}\n${block}${picked}`;
  if (part) return `${base.page}\n${block}${orderExtract(full, budget, [track], true, NOT_A_LIST)}`;
  let body = orderExtract(base.full, budget, [track], fromMusic, fromMusic ? MAKING_OF_MUSIC : MUSIC_HEADING);
  // A music article with no making-of section: its other sections, bar the lists
  if (fromMusic && body.length < MIN_CONTEXT_CHARS * 2) body = orderExtract(base.full, budget, [track], true, NOT_A_LIST);
  return `${base.page}\n${block}${body}`;
}

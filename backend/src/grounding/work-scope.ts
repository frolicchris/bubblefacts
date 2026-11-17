import { config } from "../config";
import { escapeRe, removeAll, withoutRefsAndComments } from "../text";
import { setCapped } from "../capped-map";
import { normalizeTitle } from "./titles";
import { STABLE_AGE_MS, USER_AGENT, WIKI_API } from "./wikipedia";
import { contentTokens } from "../screening/similarity";

// Work scope: sentences about another work (italic titles) kept out of the reference
// (ARCHITECTURE.md: The life of one song)

// WORK_SCOPE=off reads every sentence of a game's or a work's article, as before
export const workScope = { on: process.env.WORK_SCOPE !== "off" };

/** One wikitext sentence as plain words, with its italic titles */
export interface ItalicSentence {
  text: string;
  /** Each italic title as shown, its link target if one link, and whether bold too (the article's subject) */
  works: Array<{ title: string; target: string; subject: boolean }>;
  /** Paragraph number through the article */
  para: number;
}

// Inline templates whose text is part of the sentence -> the argument holding it
const TEXT_TEMPLATES: Record<string, number> = { nihongo: 1, nihongo2: 1, nihongo3: 1, "nihongo foot": 1, lang: 2, nowrap: 1, nobr: 1, small: 1, ill: 1, "interlanguage link": 1, "not a typo": 1, vgy: 1, "'": -1 };

/** Without `[[File:...]]` and similar links, which nest other links */
function withoutFileLinks(t: string): string {
  let out = "";
  let i = 0;
  while (i < t.length) {
    const m = /\[\[(?:File|Image|Category):/i.exec(t.slice(i));
    if (!m) return out + t.slice(i);
    out += t.slice(i, i + m.index);
    let depth = 0;
    let j = i + m.index;
    for (; j < t.length - 1; j++) {
      if (t.startsWith("[[", j)) { depth++; j++; } else if (t.startsWith("]]", j)) { depth--; j++; if (depth === 0) break; }
    }
    i = j + 1;
  }
  return out;
}

// Wikitext as plain sentences with their italic titles (''Title''; the subject's in bold italics).
// Approximate on purpose: refs, tables and templates go, so words match the plain text loosely
export function italicSentences(wikitext: string): ItalicSentence[] {
  let t = withoutRefsAndComments(wikitext);
  t = withoutFileLinks(t);
  // A link's "|" isn't a template's
  t = t.replace(/\[\[([^[\]]*)\]\]/g, (m) => m.replace(/\|/g, "\u0003"));
  for (let guard = 0; guard < 20 && /\{\{[^{}]*\}\}/.test(t); guard++) {
    t = t.replace(/\{\{([^{}]*)\}\}/g, (_, body: string) => {
      const parts = body.split("|");
      const at = TEXT_TEMPLATES[parts[0].trim().toLowerCase()];
      return at === undefined ? "" : at < 0 ? "'" : (parts[at] ?? "").replace(/^\s*\d+\s*=\s*/, "");
    });
  }
  // Tags go until none is left ("<scr<b>ipt>" leaves "<script>" once), then stray angle brackets
  t = removeAll(t.replace(/\{\|[\s\S]*?\|\}/g, ""), /<[^>]+>/g).replace(/[<>]/g, "");
  // Bold italics: the subject's own title; then bold alone dropped, italics marked
  t = t.replace(/'''''([^'\n][^\n]*?)'''''/g, "\u0001\u0004$1\u0002").replace(/'''/g, "").replace(/''([^'\n][^\n]*?)''/g, "\u0001$1\u0002");
  const linkText = (s: string) => s.replace(/\[\[([^\]\u0003]*)(?:\u0003([^\]]*))?\]\]/g, (_, target: string, shown?: string) => shown ?? target.replace(/#.*$/, "")).replace(/\[https?:\/\/\S+\s*([^\]]*)\]/g, "$1");
  const out: ItalicSentence[] = [];
  let para = 0;
  for (const line of t.split("\n")) {
    if (/^\s*=+[^=]+=+\s*$/.test(line) || !line.trim()) {
      para++;
      continue;
    }
    para++;
    for (const raw of line.split(/(?<=[.!?]["”]?\u0002?)\s+(?=["“\u0001]?\p{Lu})/u)) {
      const works: ItalicSentence["works"] = [];
      for (const m of raw.matchAll(/\u0001(\u0004?)([^\u0002]*)\u0002/g)) {
        const one = /^\[\[([^\]\u0003]+)(?:\u0003([^\]]+))?\]\]$/.exec(m[2].trim());
        const title = linkText(m[2]).replace(/[\u0001-\u0004]/g, "").trim();
        if (title) works.push({ title, target: one ? one[1].replace(/#.*$/, "").trim() : "", subject: !!m[1] });
      }
      const text = linkText(raw).replace(/[\u0001-\u0004]/g, "").replace(/^[*#:;]+\s*/, "").replace(/\s+/g, " ").trim();
      if (text) out.push({ text, works, para });
    }
  }
  return out;
}

// In too many titles to say two works are related
const GENERIC_TITLE_WORDS = new Set("music game games video series soundtrack soundtracks original edition version theme album songs song live best greatest hits collection volume part chapter story world legend super".split(" "));

// A title's distinctive words: 4+ letters, not generic
const titleWords = (s: string) => normalizeTitle(s).split(" ").filter((w) => w.length >= 4 && !GENERIC_TITLE_WORDS.has(w));

/** The work a page is about: "Some Game" from "Music of Some Game", "Some Game (soundtrack)" */
export function workOfPage(page: string): string {
  return page.replace(/\s*\([^)]*\)\s*$/, "").replace(/^(?:the )?(?:music|soundtracks?|scores?) (?:of|from|for) (?:the )?/i, "").replace(/\s+(?:series|franchise)$/i, "").trim();
}

/** The requested work's names, normalized: the game field, the page's work, the lead's bold italic titles */
export function requestedWork(game: string, page: string, sentences: ItalicSentence[] = []): string[] {
  const firstPara = sentences.find((s) => s.works.some((w) => w.subject))?.para;
  const subject = sentences.filter((s) => s.para === firstPara).flatMap((s) => s.works.filter((w) => w.subject).map((w) => w.title));
  const plain = game.replace(/\s+(?:CD|HD|DX|Remastered|Remaster|Deluxe|Definitive Edition|Complete Edition)$/i, "");
  const titles = [game, plain, workOfPage(page), ...subject];
  // "Dark Moon" for "Some Mansion: Dark Moon": a subtitle of two words or more is the work's short name
  const subtitles = titles.map((t) => /:\s*(.+)$/.exec(t)?.[1] ?? "").filter((t) => t.trim().split(/\s+/).length >= 2);
  // Paired versions: "Some Red, Blue and Yellow" is also "Some Red", "Red and Blue" and, in italics, "Blue"
  const versions = titles.flatMap((t) => {
    const m = /^(.*?)\b((?:[\p{L}\p{N}'’-]+,\s+)*[\p{L}\p{N}'’-]+,?\s+(?:and|&)\s+[\p{L}\p{N}'’-]+)$/u.exec(t.trim());
    if (!m) return [];
    const items = m[2].split(/,?\s+(?:and|&)\s+|,\s+/);
    const pairs = items.flatMap((a, i) => items.slice(i + 1).map((b) => `${a} and ${b}`));
    return [...items, ...items.map((i) => `${m[1]}${i}`), ...pairs];
  });
  return [...new Set([...titles, ...subtitles, ...versions].map((t) => normalizeTitle(t).replace(/^the /, "")).filter((n) => n.length >= 3))];
}

// Albums of a work's own music: "Original Soundtrack", "Original Sound Version", "Piano Collections"
const MUSIC_ALBUM = /\b(?:soundtracks?|OST|OSV|original sound|sound version|music|arranged|arrange|piano|orchestral|orchestra|symphonic|remix(?:es)?|album|tracks|collections?|grand finale|concert|melodies)\b/i;
// A spoken album or radio play: not its music
const NOT_MUSIC_ALBUM = /\b(?:drama|radio)\b/i;

// Makes a mention of the work one of its editions: "the 2019 remake of Some Game"
const EDITION_WORD = /\b(?:remake|remaster(?:ed)?|reboot|re-?release|reimagining|sequel|prequel|spin-?off|port|follow-?up|successor)\b/i;
// Sections about other works: "Sequels", "Remake", "Spin-offs"
const EDITION_HEADING = /\b(?:sequels?|prequels?|remakes?|remasters?|reboots?|spin-?offs?|successors?)\b/i;
// About an edition, not the work: "The remake adds ...", "Its 2019 remaster ..."
const EDITION_LED = /^(?:In \d{4}, )?(?:The|A|An|This|Its|Their) (?:\d{4} |later |enhanced |HD |high-definition |3D |Western |English )?(?:remake|remaster|remastered version|reboot|re-?release|sequel|prequel|spin-?off|port|follow-?up|reimagining)\b/;
// Goes on about what the sentence before named
const LEANS_ON_PREVIOUS = /^["“]?(?:It|Its|They|Their|This|These|The (?:game|remake|remaster|sequel|prequel|port|reboot|film|album|soundtrack|version|release|title))\b/;

/** Whether a sentence names the work in words: whole, not in a longer italic title, not by an edition word */
function namesWorkPlainly(sentence: string, allNames: string[], longer: string[], exempt = ""): { clean: boolean; edition: boolean } {
  // One word ("red") is too common to be the work's name in plain text; in italics it is
  const names = allNames.filter((n) => n.includes(" ") || n.length >= 8);
  let text = ` ${normalizeTitle(sentence)} `;
  for (const l of longer.map(normalizeTitle).filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(` ${l} `).join(" \u0005 ");
  let clean = false;
  let edition = false;
  for (const n of names) {
    let from = 0;
    for (let at = text.indexOf(` ${n} `, from); at >= 0; at = text.indexOf(` ${n} `, from)) {
      const before = text.slice(Math.max(0, at - 40), at).split(" ").slice(-4).join(" ");
      const after = text.slice(at + n.length + 2).split(" ").slice(0, 2).join(" ");
      if (n !== exempt && (EDITION_WORD.test(before) || /^(?:remastered|remaster|remake|hd|dx|deluxe|definitive|royal|zero|plus|reloaded|redux)\b/.test(after))) edition = true;
      else clean = true;
      from = at + n.length + 1;
    }
  }
  return { clean, edition };
}

/** The article's sentences about another work than the requested one (ARCHITECTURE.md: The life of one song) */
export function otherWorkSentences(full: string, wikitext: string, game: string, page: string): Set<string> {
  const wiki = italicSentences(wikitext);
  const names = requestedWork(game, page, wiki);
  const out = new Set<string>();
  if (!names.length || !wiki.length) return out;
  const own = new Set(names.flatMap(titleWords));
  const index = wiki.map((w) => contentTokens(w.text));
  const namesEdition = EDITION_WORD.test(game);
  const norm = (t: string) => normalizeTitle(t).replace(/^the /, "");
  // The work's own album ("Some Game Original Soundtrack"), not a related game's ("Melodies of Some Game Advance")
  const games = [...new Set(wiki.flatMap((x) => x.works).map((w) => norm(w.title)).filter((t) => !names.includes(t) && !MUSIC_ALBUM.test(t) && titleWords(t).some((x) => own.has(x))))];
  const ownAlbum = (t: string) => {
    const n = ` ${norm(t)} `;
    return names.some((x) => x.includes(" ") && n.includes(` ${x} `)) && MUSIC_ALBUM.test(t) && !NOT_MUSIC_ALBUM.test(t) && !games.some((g) => n.includes(` ${g} `));
  };
  // A link to "Some Game (TV series)" from "Some Game (video game)" is the show, not the game
  const qualifier = (t: string) => /\(([^)]*)\)\s*$/.exec(t)?.[1]?.toLowerCase() ?? "";
  const isRequested = (w: { title: string; target: string }) =>
    (w.target
      ? names.includes(norm(w.target)) || (names.includes(norm(workOfPage(w.target))) && (!qualifier(w.target) || qualifier(w.target) === qualifier(page)))
      : names.includes(norm(w.title))) || ownAlbum(w.title);
  // A series by one word ("Some" for "Some Mania") or as a kind of game: "the early Some games", "a Some fangame"
  const asSeries = (w: { title: string }, s: string) => {
    const t = norm(w.title);
    if (!t.includes(" ") && names.some((n) => n.startsWith(`${t} `))) return true;
    return new RegExp(String.raw`${escapeRe(w.title)}['’]?s?\s+(?:video game\s+)?(?:series|franchise|saga|games|titles|fans|fangames?|community|universe|characters?|mascot)\b`, "i").test(s);
  };
  const related = (w: { title: string }) => titleWords(w.title).some((x) => own.has(x));
  // Related italic titles, to spot a section headed with one ("=== Some Game Zero ===")
  const otherTitles = new Set(wiki.flatMap((x) => x.works).filter((w) => !isRequested(w) && related(w)).map((w) => norm(w.title)));
  // "Some Game Zero" from the "Some Game" article: "a remake, Some Game Zero" names the request itself
  const requestIsEdition = norm(game) !== norm(workOfPage(page)) ? norm(game) : "";
  const heads: Array<{ level: number; other: boolean }> = [];
  for (const line of full.split("\n")) {
    const head = /^(=+)\s*(.+?)\s*=+\s*$/.exec(line.trim());
    if (head) {
      while (heads.length && heads[heads.length - 1].level >= head[1].length) heads.pop();
      const h = norm(head[2]);
      heads.push({ level: head[1].length, other: (otherTitles.has(h) && !names.includes(h)) || (!namesEdition && EDITION_HEADING.test(head[2])) });
      continue;
    }
    const inOther = heads.some((x) => x.other);
    let carry: boolean = false;
    for (const s of line.split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})/u).map((x) => x.trim()).filter(Boolean)) {
      if (inOther) {
        out.add(s);
        continue;
      }
      const want = contentTokens(s);
      let best = -1;
      let share = 0;
      if (want.size >= 4) {
        index.forEach((have, i) => {
          let n = 0;
          for (const t of want) if (have.has(t)) n++;
          // Over the longer of the two: a short sentence doesn't match a long one containing it
          const fit = n / Math.max(want.size, have.size);
          if (fit > share) [best, share] = [i, fit];
        });
      }
      const works = best >= 0 && share >= 0.5 ? wiki[best].works : [];
      const series = (w: { title: string; target: string }) => /\b(?:series|franchise)\b/i.test(w.target) || asSeries(w, s);
      const others = works.filter((w) => !isRequested(w) && !series(w) && related(w));
      // The work named in words or italics, not inside another title or as "the remake of Some Game"
      const plainly = namesWorkPlainly(s, [...names, ...works.filter(isRequested).map((w) => norm(w.title))], works.filter((w) => !isRequested(w)).map((w) => w.title), requestIsEdition);
      // "It was a hit, outselling Some Game 11": led by "It" or "The game", it's the article's own work,
      // unless the one before was about another or it says it's a remake
      const subjectLed: boolean =
        !carry && !plainly.edition && (/^["“]?(?:It|Its|The game|This game)\b/.test(s) || /^[^.;]{0,80}?,\s+(?:it|the game) (?:is|was|became|remains)\b/.test(s));
      const namesIt: boolean = plainly.clean || subjectLed;
      const edition: boolean = !namesEdition && !namesIt && (EDITION_LED.test(s) || plainly.edition);
      const leansBack: boolean = carry && !namesIt && !works.length && LEANS_ON_PREVIOUS.test(s);
      const drop: boolean = (others.length > 0 && !namesIt) || edition || leansBack;
      if (drop) out.add(s);
      carry = drop;
    }
  }
  return out;
}

// Wikitext by page, for infobox facts and italic titles: one request per article
export const wikitextCache = new Map<string, { text: string; at: number }>();

/** An article's wikitext ("" if missing), remembered; throws when Wikipedia can't be reached */
export async function loadWikitext(page: string): Promise<string> {
  const hit = wikitextCache.get(page);
  if (hit) return hit.text;
  // Newest version at least STABLE_AGE_MS old, as for the article's text (#242)
  const before = new Date(Date.now() - STABLE_AGE_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
  const url = `${WIKI_API}?${new URLSearchParams({ action: "query", prop: "revisions", rvprop: "content", rvslots: "main", rvlimit: "1", rvdir: "older", rvstart: before, titles: page, redirects: "1", format: "json", formatversion: "2" })}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(config.groundingTimeoutMs), headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { query?: { pages?: Array<{ revisions?: Array<{ slots?: { main?: { content?: string } } }> }> } };
  const text = data.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content ?? "";
  setCapped(wikitextCache, page, { text, at: Date.now() }, 60);
  return text;
}

/** An article's wikitext, or "" when it can't be had; never throws */
export async function wikitextOf(page: string): Promise<string> {
  if (!page) return "";
  try {
    return await loadWikitext(page);
  } catch (err) {
    console.warn(`[Grounding] Wikitext lookup failed for "${page}": ${err instanceof Error ? err.message : err}`);
    return "";
  }
}

export const workScopeCache = new Map<string, Set<string>>();
// Five apostrophes: bold italics, how Wikipedia names a work article's subject
const BOLD_ITALIC = new RegExp(`${"'".repeat(5)}[^'\n]`);

/** These articles' sentences about another work than `game`, or null */
export async function otherWorkScope(articles: Array<{ page: string; full: string } | null | undefined>, game: string): Promise<Set<string> | null> {
  if (!workScope.on || !game.trim()) return null;
  const out = new Set<string>();
  for (const a of articles) {
    if (!a?.full) continue;
    const key = `${a.page}\0${normalizeTitle(game)}`;
    let drop = workScopeCache.get(key);
    if (!drop) {
      const wikitext = await wikitextOf(a.page);
      // Only a work's article: its lead names it in bold italics; a person's or band's is bold alone
      const aWork = BOLD_ITALIC.test(wikitext.split(/\n==/)[0]) || /^(?:music|soundtracks?|scores?) (?:of|from|for)\b|\((?:[^)]*\s)?(?:soundtrack|score|album)\)$/i.test(a.page);
      drop = wikitext && aWork ? otherWorkSentences(a.full, wikitext, game, a.page) : new Set<string>();
      if (workScopeCache.size > 200) workScopeCache.clear();
      workScopeCache.set(key, drop);
      if (drop.size) console.log(`[Grounding] "${a.page}": ${drop.size} sentences about another work than "${game}" left out`);
    }
    for (const s of drop) out.add(s);
  }
  return out.size ? out : null;
}

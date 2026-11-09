import { config } from "../config";
import type { SSLSong } from "../types";
import { setCapped } from "../capped-map";
import { itemLabels, knownPerson, personItem, searchWorks, wholesOf, WikidataBusy, type WorkItem, workItems } from "../wikidata";
import { MAX_CONTEXT_CHARS, MIN_CONTEXT_CHARS } from "../fact-limits";
import { type ClassicalTitle, dropVersionTags, FORM_WORDS, normalizeKeys, normalizeTitle, ORDINAL_WORDS, parseClassicalTitle, resolveGameAndTrack, ROMAN_NUMBER } from "./titles";
import { qualifierOf, ROMAN } from "./relevance";
import { NOT_A_LIST, orderExtract, ownArticleExtract, RateLimited, wholeSentences, wikiExtract, withoutVideoSections } from "./wikipedia";
import { openingSays, opensAboutMusicOrWork } from "./covers";
import { GENERIC_SECTION, SCREEN_OR_BOOK, sectionsOf } from "./summary";
import { CATEGORY_ARTIST, CREDIT_JOIN, type Grounded, groundingCache, MAX_GROUNDING, NEGATIVE_TTL_MS, NO_ONE } from "./readings";
import { classicalKey, classicalPages, isPerformerArticle } from "./work-match";

/**
 * Classical works found through Wikidata (issue #260): the work's article,
 * its movement or section, and its parent work.
 */

/** Words that say how a piece is numbered or what key it's in, not what it's called. */
const NOT_A_NAME_WORD = new Set(["in", "major", "minor", "sharp", "flat", "op", "opus", "no", "nr", "nos", "bwv", "kv", "hob", "rv", "hwv", "woo", "the", "an", "of", "and", "for", "from", "la", "le", "les", "el", "der", "die", "das"]);

/** The words of a piece's name: no numbers, keys, catalog words or roman numerals. */
export function nameWords(s: string): string[] {
  return normalizeTitle(normalizeKeys(s))
    .split(" ")
    .filter((w) => w.length > 1 && !/\d/.test(w) && !NOT_A_NAME_WORD.has(w) && !(w in ROMAN));
}

/** The key a name gives, spelled "c sharp minor", or "". */
function keyIn(s: string): string {
  const t = normalizeTitle(normalizeKeys(s));
  return /(?:^| )([a-g](?: sharp| flat)? (?:major|minor))(?= |$)/.exec(t)?.[1] ?? /(?:^| )in ([a-g](?: sharp| flat)?)(?= |$)/.exec(t)?.[1] ?? "";
}

const numbersOf = (s: string): string[] => [...(normalizeTitle(s).match(/\d+/g) ?? [])];

/** Whether a request is specific enough to name one work: not a bare "Prelude" or "Nocturne". */
export function namesOneWork(parsed: ClassicalTitle): boolean {
  if (parsed.numbers.length || parsed.key) return true;
  return [...nameWords(parsed.name), ...nameWords(parsed.alias)].some((w) => !FORM_WORDS.test(w));
}

/**
 * Whether a work's Wikidata item is the piece a request names: every number
 * the request gives is among the item's (in its names or catalog codes), a
 * key it names agrees, and one of its names (label, alias, nickname) holds
 * the request's words, or the request holds all of the name's ("Alla Turca"
 * in "Rondo Alla Turca"). Without `strict`, a catalog code the item has is
 * enough ("BWV 1007 Prelude": the request's word names a movement).
 * Returns how it matched, or "".
 */
export function workFits(item: WorkItem, parsed: ClassicalTitle, strict = false): WorkFit {
  const nums = new Set([...item.names, ...item.catalogs].flatMap(numbersOf));
  if (!parsed.numbers.every((n) => nums.has(n))) return !strict && setOfThePiece(item, parsed, nums) ? "set" : "";
  if (parsed.key) {
    const want = normalizeTitle(normalizeKeys(parsed.key));
    const keys = item.names.map(keyIn).filter(Boolean);
    if (keys.length && !keys.some((k) => k === want || (!/major|minor/.test(want) && k.startsWith(`${want} `)))) return "";
  }
  const covers = (req: string[]) =>
    req.length > 0 &&
    item.names.some((n) => {
      const w = nameWords(n);
      return req.every((x) => w.includes(x)) || (w.length >= 2 && w.every((x) => req.includes(x)));
    });
  // "Le cygne" (alias "The Swan") over "The Dying Swan": a name with no other words.
  const exactly = (req: string[]) => req.length > 0 && item.names.some((n) => sameWords(nameWords(n), req));
  if (exactly(nameWords(parsed.name)) || exactly(nameWords(parsed.alias))) return "exact";
  if (covers(nameWords(parsed.name)) || covers(nameWords(parsed.alias))) return "name";
  if (strict || !parsed.catalogs.length) return "";
  // In strict mode (a performer's piece, by its title alone) only a name will do.
  // "BWV 1007" is filed as "1007", with the catalog as a qualifier.
  const codes = parsed.catalogs.map((c) => c.split(" ").slice(1).join(" ").toLowerCase());
  const has = item.catalogs.some((c) => c.toLowerCase().split(/[\s,/]+/).some((x) => codes.includes(x)));
  return has ? "catalog" : "";
}

/** How a work's item fits a request: its name exactly, a name holding the request's words, the set the numbered piece is in, or its catalog code. */
export type WorkFit = "exact" | "name" | "set" | "catalog" | "";
const FIT_ORDER: Array<Exclude<WorkFit, "">> = ["exact", "name", "set", "catalog"];
const sameWords = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x)) && b.every((x) => a.includes(x));
/** Words that count a set's pieces: "Two Arabesques", "Deux arabesques". */
const COUNT_WORDS = new Set(["two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "twelve", "deux", "trois", "quatre", "cinq", "sept", "huit", "set"]);

/**
 * Whether an item is the set a numbered piece belongs to: "Two Arabesques"
 * for "Arabesque No. 1", "Nocturnes, Op. 9" for "Nocturne Op. 9 No. 2". Its
 * name is the request's in the plural, and its catalog numbers are the request's.
 */
function setOfThePiece(item: WorkItem, parsed: ClassicalTitle, nums: Set<string>): boolean {
  const req = nameWords(parsed.name);
  if (!req.length || !parsed.numbers.length || !parsed.catalogs.flatMap(numbersOf).every((n) => nums.has(n))) return false;
  return item.names.some((n) => {
    const words = nameWords(n).filter((w) => !COUNT_WORDS.has(w));
    const singular = words.map((w) => (w.endsWith("s") && req.includes(w.slice(0, -1)) ? w.slice(0, -1) : w));
    return singular.some((w, i) => w !== words[i]) && sameWords(singular, req);
  });
}

/**
 * The work a request names among search hits, by the best way any fits.
 * Several works fitting as well is a guess, so none is taken ("Mazurka in F
 * minor" is one of three: they come back `tied`), unless only one has an
 * article, or all lead to the same article (two items for one piece); a part
 * beats the whole it is in, and an item with no article and no parent leads nowhere.
 */
export function pickWork(items: WorkItem[], parsed: ClassicalTitle, strict = false): { work: WorkItem; by: Exclude<WorkFit, ""> } | { tied: WorkItem[]; by: Exclude<WorkFit, ""> } | null {
  const fits = items.map((work) => ({ work, by: workFits(work, parsed, strict) })).filter((f) => f.by);
  for (const by of FIT_ORDER) {
    let at = fits.filter((f) => f.by === by).map((f) => f.work);
    at = at.filter((w) => !at.some((o) => o !== w && o.parents.includes(w.id)));
    const leads = at.filter((w) => w.page || w.parents.length);
    if (leads.length) at = leads;
    if (!at.length) continue;
    const paged = at.filter((w) => w.page);
    const leadsTo = (w: WorkItem) => w.page || w.parents[0];
    const one = at.length === 1 || at.every((w) => leadsTo(w) === leadsTo(at[0])) ? at[0] : paged.length === 1 ? paged[0] : null;
    return one ? { work: one, by } : { tied: at, by };
  }
  return null;
}

/**
 * One of several works that fit as well, when only one of them leads to an
 * article through the works it is part of: "Dance of the Sugar Plum Fairy" in
 * "The Nutcracker pas de deux" (in "The Nutcracker") and again in a "Nutcracker
 * Suite" item with no article. Several articles, or none, is a guess: null.
 */
async function breakTie(tied: WorkItem[], parsed: ClassicalTitle): Promise<WorkItem | null> {
  if (!tied.some((w) => w.page)) {
    const parents = await workItems([...new Set(tied.flatMap((w) => w.parents))].slice(0, 10));
    const grand = await workItems([...new Set(parents.filter((p) => !p.page).flatMap((p) => p.parents))].slice(0, 10));
    const pageOf = (id: string): string => {
      const p = [...parents, ...grand].find((x) => x.id === id);
      return p ? p.page || p.parents.map(pageOf).find(Boolean) || "" : "";
    };
    const leads = tied.map((w) => ({ w, to: w.parents.map(pageOf).find(Boolean) ?? "" })).filter((x) => x.to);
    if (leads.length && leads.every((x) => x.to === leads[0].to)) return leads[0].w;
  }
  console.log(`[Grounding] Several works fit "${parsed.name}": ${tied.map((w) => w.label || w.id).join(", ")}, taking none`);
  return null;
}

/** What to search Wikidata for: the title with its numbers, then without the key, then its other name, its catalog code or its name alone. */
export function workQueries(parsed: ClassicalTitle): string[] {
  const numbered = parsed.numbers.filter((n) => !parsed.catalogs.some((c) => numbersOf(c).includes(n))).map((n) => `No. ${n}`);
  const plain = [parsed.name, ...parsed.catalogs, ...numbered].filter(Boolean).join(" ");
  // Wikidata's search wants every word: "Arabesque No. 1" finds nothing where "Arabesque" finds the set.
  const out = [parsed.key ? `${plain} ${parsed.key}` : plain, plain, parsed.alias, parsed.catalogs.join(" "), parsed.name];
  return [...new Set(out.map((q) => q.trim()).filter(Boolean))].slice(0, 3);
}

/**
 * The section of a parent work's article about one piece: its heading holds
 * one of the piece's names, or a name holds the heading's words, and any
 * number in the heading is the piece's ("Suite No. 1 in G major, BWV 1007",
 * not "Suite No. 2"). In a set, a heading of only the piece's number ("No. 2
 * in E♭ major") or one that starts with it ("1. Andantino con moto") counts.
 * Generic sections (Background, Reception) never count.
 */
export function pieceSection(full: string, names: string[], numbers: string[]): { heading: string; text: string } | null {
  const lines = withoutVideoSections(full).split("\n");
  const own = new Set([...numbers, ...names.flatMap(numbersOf)]);
  // The piece's place in its set: "No. 2".
  const position = new Set(names.flatMap((n) => [...n.matchAll(/\b(?:no|nr)\.?\s*(\d+)/gi)].map((m) => m[1])));
  for (const s of sectionsOf(lines)) {
    if (GENERIC_SECTION.test(s.heading)) continue;
    const hw = nameWords(s.heading);
    const hn = numbersOf(s.heading);
    if (!hn.every((n) => own.has(n))) continue;
    const lead = /^(\d+|[IVX]+)\.\s/.exec(s.heading)?.[1];
    const at = lead ? (ROMAN_NUMBER[lead.toLowerCase()] ?? Number(lead)).toString() : "";
    const named =
      (hw.length === 0 && hn.length > 0 && hn.every((n) => position.has(n))) ||
      (!!at && position.has(at)) ||
      names.some((n) => {
        const nw = nameWords(n);
        return (hw.length > 0 && hw.every((x) => nw.includes(x))) || (nw.length > 0 && nw.every((x) => hw.includes(x)));
      });
    if (!named) continue;
    const body = lines.slice(s.from + 1, s.to).filter((l) => !/^==/.test(l)).join("\n").trim();
    if (body.length >= 80) return { heading: s.heading, text: body };
  }
  return null;
}

/** The section of a piece's article about one movement: "III. Presto agitato", "Third movement", "Variation 18". */
export function movementSection(full: string, movement: NonNullable<ClassicalTitle["movement"]>): { heading: string; text: string } | null {
  const lines = withoutVideoSections(full).split("\n");
  const ordinal = Object.entries(ORDINAL_WORDS).find(([, n]) => n === movement.n)?.[0];
  const roman = Object.entries(ROMAN_NUMBER).find(([, n]) => n === movement.n)?.[0];
  for (const s of sectionsOf(lines)) {
    const h = s.heading.toLowerCase();
    const hit =
      (roman && new RegExp(`^${roman}\\.?(?:\\s|$)`).test(h)) ||
      (ordinal && new RegExp(`\\b${ordinal} movement\\b`).test(h)) ||
      (movement.n && new RegExp(`\\b(?:movement|variation) ${movement.n}\\b|^${movement.n}\\.\\s`).test(h)) ||
      (movement.name && sharesName(s.heading, movement.name));
    if (!hit) continue;
    const body = lines.slice(s.from + 1, s.to).filter((l) => !/^==/.test(l)).join("\n").trim();
    if (body.length >= 80) return { heading: s.heading, text: body };
  }
  return null;
}

/** Whether a heading and a name hold the same words, one inside the other: "III. Alla turca" and "Rondo Alla Turca". */
function sharesName(heading: string, name: string): boolean {
  const hw = nameWords(heading);
  const nw = nameWords(name);
  return hw.length > 0 && nw.length > 0 && (hw.every((x) => nw.includes(x)) || nw.every((x) => hw.includes(x)));
}

/** Cut a section to about `max` characters, at a sentence. */
const sectionBlock = (heading: string, text: string, max = 1100) => `${heading}: ${wholeSentences(text.replace(/\s+/g, " ").slice(0, max))}`;

/** What a page can't be for a classical piece: a film, a show or a book, a person who isn't a musician, or a piece in another key. "" when it can. */
export function notForAPiece(page: string, full: string, parsed: ClassicalTitle): string {
  const qualifier = qualifierOf(page) ?? "";
  const says = openingSays(full);
  const musical = (t: string) => FORM_WORDS.test(t) || /\b(operas?|operettas?|ballets?|musicals?|pieces?|compositions?|works?|songs?|arias?|soundtracks?|scores?|movements?|sets?)\b/i.test(t);
  if (SCREEN_OR_BOOK.test(qualifier) || (SCREEN_OR_BOOK.test(says) && !musical(says))) return "is a film's, a show's or a book's article";
  // A person's article opens with their dates: "Edwin Marrow (1790–1850) was an English painter".
  const dated = /^[^.(]{0,80}\((?:[^()]*;\s*)?(?:born\b[^)]*|[^)]*\b1\d{3}\s*[–-]\s*(?:1\d|20)\d{2})\)/.test(full.slice(0, 300));
  if (dated && !isPerformerArticle(page, full) && !musical(says) && !opensAboutMusicOrWork(full)) return "is about a person who isn't a musician";
  const wanted = parsed.key ? normalizeTitle(normalizeKeys(parsed.key)) : "";
  const got = keyIn(page);
  if (wanted && got && got !== wanted && !(!/major|minor/.test(wanted) && got.startsWith(`${wanted} `))) return `is in ${got}, not ${parsed.key}`;
  return "";
}

/** Whether a request asks for a classical piece, as far as the title and what's known of the artist tell. */
export function classicalAsk(song: SSLSong): ClassicalTitle | null {
  if (!config.classicalLookup) return null;
  const parsed = parseClassicalTitle(dropVersionTags(song.title.trim()));
  const person = knownPerson(song.artist ?? "");
  return parsed.classical || person?.historic || person?.classicalPerformer ? parsed : null;
}

/** An artist field that could name one person or ensemble: a few words, no numbers, not "Traditional". */
const personLike = (artist: string) => !!artist && artist.split(/\s+/).length <= 5 && !/\d/.test(artist) && !NO_ONE.test(artist) && !CATEGORY_ARTIST.test(artist) && !CREDIT_JOIN.test(artist);

/** The reference built from a work's own article, or from its parent work's, or null. */
async function classicalArticle(
  work: WorkItem,
  parsed: ClassicalTitle,
  composer: string,
  usable: (title: string) => boolean,
  performer = false,
  asSet = false
): Promise<{ text: string; page: string; section: boolean | null } | null> {
  // The set itself was found ("Two Arabesques" for "Arabesque No. 1"): read it as the piece's parent.
  const numbered = parsed.numbers.filter((n) => !parsed.catalogs.some((c) => numbersOf(c).includes(n)));
  const piece = asSet ? { ...work, id: "", label: [parsed.name, ...numbered.map((n) => `No. ${n}`)].join(" "), names: [], catalogs: [], page: "", parents: [] } : work;
  if (asSet) return classicalParent(piece, [work], parsed, composer, usable);
  if (work.page && usable(work.page)) {
    const full = await wikiExtract(work.page);
    const why = full ? notForAPiece(work.page, full, parsed) : "is a disambiguation page";
    if (full && !why) {
      const part = parsed.movement ? movementSection(full, parsed.movement) : null;
      // Played by the artist on the list, written by someone else: the reference says who wrote it.
      const note = performer && composer ? `About this piece: ${work.label || parsed.name} is by ${composer}.\n\n` : "";
      const block = note + (part ? `${sectionBlock(part.heading, part.text)}\n\n` : "");
      const extract = ownArticleExtract(full, MAX_CONTEXT_CHARS - work.page.length - 1 - block.length, [work.label, composer].filter(Boolean));
      if (block.length + extract.length >= MIN_CONTEXT_CHARS) return { text: `${work.page}\n${block}${extract}`, page: work.page, section: null };
    } else console.log(`[Grounding] "${work.page}" ${why}, skipping`);
  }
  // No article of its own: the work it is part of (P361), or one that lists it as a part (P527), two levels up at most.
  return classicalParent(piece, work.parents.length ? await workItems(work.parents.slice(0, 3)) : await wholesOf(work.id), parsed, composer, usable);
}

/** The reference from the article of a work the piece is part of, led by the section about the piece when there is one. */
async function classicalParent(
  work: WorkItem,
  parents: WorkItem[],
  parsed: ClassicalTitle,
  composer: string,
  usable: (title: string) => boolean
): Promise<{ text: string; page: string; section: boolean | null } | null> {
  let level = parents;
  for (let depth = 0; depth < 2 && level.length; depth++) {
    for (const parent of level.filter((p) => p.page && usable(p.page))) {
      const full = await wikiExtract(parent.page);
      if (!full || notForAPiece(parent.page, full, { ...parsed, key: "" })) continue;
      const section = pieceSection(full, [...work.names, work.label, parsed.name, parsed.alias].filter(Boolean), [...parsed.numbers, ...work.catalogs.flatMap(numbersOf)]);
      const note = `About this piece: ${work.label || parsed.name} is part of ${parent.label || parent.page}${composer ? `, by ${composer}` : ""}.`;
      const block = section ? `${sectionBlock(section.heading, section.text)}\n\n` : "";
      const budget = MAX_CONTEXT_CHARS - parent.page.length - 1 - note.length - 2 - block.length;
      const extract = orderExtract(full, budget, [work.label, parsed.name, parent.label].filter(Boolean), true, NOT_A_LIST);
      if (block.length + extract.length < MIN_CONTEXT_CHARS) continue;
      return { text: `${parent.page}\n${note}\n\n${block}${extract}`, page: parent.page, section: !!section };
    }
    const up = [...new Set(level.filter((p) => !p.page).flatMap((p) => p.parents))].slice(0, 3);
    level = up.length ? await workItems(up) : [];
  }
  return null;
}

/**
 * A classical piece's article through Wikidata (issue #260), or "" to look it
 * up the usual way. The artist field is looked up first: a composer's works
 * are searched with the composer (P86), so a nickname or a catalog number
 * ("Moonlight Sonata", "BWV 1007") finds the work, and only a work whose
 * names, numbers and key fit the request counts. A performer (a pianist, an
 * orchestra) has the piece looked up by its title alone, the composer named
 * in the reference. A piece with no article of its own is read from its
 * parent work's ("Clair de lune" in "Suite bergamasque"), led by the section
 * about it when there is one.
 */
export async function classicalGrounding(song: SSLSong, usable: (title: string) => boolean): Promise<Grounded> {
  const none = { text: "", unreachable: false };
  const artist = (song.artist ?? "").trim();
  // "Beethoven: Fur Elise" by Beethoven is "Fur Elise".
  const title = resolveGameAndTrack(song).track || dropVersionTags(song.title.trim());
  const parsed = parseClassicalTitle(title);
  if (!personLike(artist) || (!parsed.name && !parsed.catalogs.length) || !namesOneWork(parsed)) return none;
  // "Moonlight Sonata (3rd Movement)" isn't "Moonlight Sonata": the movement leads its reference.
  const key = `\0classical\0${normalizeTitle(artist)}\0${normalizeTitle(title)}\0${JSON.stringify(parsed.movement)}`;
  const hit = groundingCache.get(key);
  if (hit && (hit.text || Date.now() - hit.at < NEGATIVE_TTL_MS) && (!hit.text || usable(hit.text.split("\n")[0]))) return { text: hit.text, unreachable: false };
  try {
    const person = await personItem(artist);
    if (!person || !(parsed.classical || person.historic || person.classicalPerformer)) {
      setCapped(groundingCache, key, { text: "", at: Date.now() }, MAX_GROUNDING);
      return none;
    }
    let found: { work: WorkItem; by: Exclude<WorkFit, ""> } | null = null;
    let composer = "";
    let performer = false;
    if (person.composer) {
      for (const q of workQueries(parsed)) {
        const picked = pickWork(await searchWorks(q, person.id), parsed);
        // Several works fit: another search would only pick one of them.
        if (picked && "tied" in picked) {
          const work = await breakTie(picked.tied, parsed);
          found = work ? { work, by: picked.by } : null;
          break;
        }
        found = picked;
        if (found) break;
      }
      if (found) composer = person.label;
    }
    // A performer, or a composer of our time playing someone else's piece: the piece by its title alone.
    if (!found && !person.historic && (person.classicalPerformer || parsed.classical)) {
      for (const q of workQueries(parsed).slice(0, 2)) {
        const picked = pickWork(await searchWorks(q, null), parsed, true);
        if (picked && "tied" in picked) {
          const work = await breakTie(picked.tied, parsed);
          found = work ? { work, by: picked.by } : null;
          break;
        }
        found = picked;
        if (found) break;
      }
      if (found) {
        composer = Object.values(await itemLabels(found.work.composers.slice(0, 2))).filter(Boolean).join(" and ");
        performer = true;
      }
    }
    if (!found) {
      console.log(`[Grounding] No Wikidata work for "${song.title}" by ${person.label}`);
      setCapped(groundingCache, key, { text: "", at: Date.now() }, MAX_GROUNDING);
      return none;
    }
    // The request names a movement when only the catalog code matched ("Prelude" of BWV 1007),
    // or when the work's name is only part of it ("Rondo Alla Turca" by the sonata's alias "Alla Turca").
    const part = found.by === "catalog" || (found.by === "name" && !found.work.names.some((n) => nameWords(parsed.name).every((w) => nameWords(n).includes(w))));
    const hinted = part && !parsed.movement && parsed.name ? { ...parsed, movement: { name: parsed.name } } : parsed;
    const article = await classicalArticle(found.work, hinted, composer, usable, performer, found.by === "set");
    if (!article) {
      console.log(`[Grounding] Wikidata's work ${found.work.id} (${found.work.label}) for "${song.title}" has no article to read`);
      setCapped(groundingCache, key, { text: "", at: Date.now() }, MAX_GROUNDING);
      return none;
    }
    classicalPages.set(classicalKey(article.page, song.title), { section: article.section });
    const how = article.section === null ? "its own article" : article.section ? "its parent work's article, with a section on it" : "its parent work's article";
    console.log(`[Grounding] "${song.title}" -> ${article.page} (${article.text.length} chars, Wikidata's work ${found.work.id}: ${how})`);
    setCapped(groundingCache, key, { text: article.text, at: Date.now() }, MAX_GROUNDING);
    return { text: article.text, unreachable: false };
  } catch (err) {
    if (err instanceof WikidataBusy || err instanceof RateLimited) {
      console.log(`[Grounding] Classical lookup for "${song.title}" rate-limited, not cached`);
      return { text: "", unreachable: true };
    }
    console.warn(`[Grounding] Classical lookup failed for "${song.title}": ${err instanceof Error ? err.message : err}`);
    return { text: "", unreachable: true };
  }
}

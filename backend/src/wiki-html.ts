/**
 * An older version of an article as plain text, in the shape Wikipedia's
 * own plain-text extracts have ("== Heading ==" lines, one paragraph a line).
 * Plain-text extracts exist only for the newest version; an older one comes
 * as HTML (issue #242: only versions at least 72 hours old are read).
 *
 * A single pass over the tags, without regular expressions over the page, so
 * no input can make it slow. The text is only ever read, never shown as HTML.
 */

/** Elements whose content isn't article prose: references, tables, infoboxes, captions, styles. */
const SKIPPED_TAGS = new Set(["style", "script", "table", "sup", "figure", "noscript", "math", "audio", "video", "img", "map"]);
/** Classes of elements left out the same way: notes above the article, reference lists, navigation boxes. */
const SKIPPED_CLASSES = [
  "shortdescription", "hatnote", "navbox", "reflist", "refbegin", "references", "mw-references-wrap", "thumb",
  "toc", "sidebar", "metadata", "ambox", "side-box", "noprint", "infobox", "gallery", "mw-editsection",
  "printfooter", "catlinks", "mw-empty-elt", "mwe-math-element", "navigation-not-searchable",
];
/** Elements that never have a closing tag. */
const VOID_TAGS = new Set(["br", "hr", "img", "meta", "link", "wbr", "input", "source", "track", "area", "col", "embed", "param"]);
/** Elements that start a new line. */
const BLOCK_TAGS = new Set(["p", "div", "li", "dd", "dt", "dl", "ul", "ol", "blockquote", "br", "tr", "section", "pre"]);

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", minus: "−", times: "×", shy: "", thinsp: " ", ensp: " ", emsp: " ",
};

/** Character references decoded in one pass, so "&amp;lt;" stays "&lt;". */
function decodeEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,8});/g, (whole, ref: string) => {
    if (ref[0] !== "#") return ENTITIES[ref] ?? whole;
    const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** A tag's name, lowercase, from its inside ("h2 id=x" -> "h2", "/p" -> "p"). */
function tagName(inside: string): string {
  let i = inside[0] === "/" ? 1 : 0;
  const start = i;
  while (i < inside.length && /[A-Za-z0-9]/.test(inside[i])) i++;
  return inside.slice(start, i).toLowerCase();
}

/** The value of a tag's class attribute, or "". */
function classOf(inside: string): string {
  const at = inside.indexOf('class="');
  if (at < 0) return "";
  const end = inside.indexOf('"', at + 7);
  return end < 0 ? "" : inside.slice(at + 7, end);
}

function skipped(name: string, cls: string): boolean {
  if (SKIPPED_TAGS.has(name)) return true;
  if (!cls) return false;
  const classes = cls.split(/\s+/);
  return SKIPPED_CLASSES.some((c) => classes.includes(c));
}

export function htmlToText(html: string): string {
  const out: string[] = [];
  let skip: { tag: string; depth: number } | null = null;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    const textEnd = lt < 0 ? html.length : lt;
    if (!skip && textEnd > i) out.push(decodeEntities(html.slice(i, textEnd)));
    if (lt < 0) break;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const gt = html.indexOf(">", lt);
    if (gt < 0) break;
    const inside = html.slice(lt + 1, gt);
    i = gt + 1;
    const name = tagName(inside);
    if (!name) continue;
    const closing = inside[0] === "/";
    const selfClosing = VOID_TAGS.has(name) || inside.endsWith("/");
    if (skip) {
      if (name === skip.tag && !selfClosing) {
        skip.depth += closing ? -1 : 1;
        if (skip.depth === 0) skip = null;
      }
      continue;
    }
    if (!closing && !selfClosing && skipped(name, classOf(inside))) {
      // A style or a script holds no tags, only text up to its end tag.
      if (name === "style" || name === "script") {
        const end = html.indexOf(`</${name}`, i);
        i = end < 0 ? html.length : end;
      }
      skip = { tag: name, depth: 1 };
      continue;
    }
    const level = /^h[2-6]$/.test(name) ? Number(name[1]) : 0;
    if (level) out.push(closing ? ` ${"=".repeat(level)}\n` : `\n${"=".repeat(level)} `);
    else if (BLOCK_TAGS.has(name)) out.push("\n");
  }
  return out
    .join("")
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\n(==+ )/g, "\n\n\n$1");
}

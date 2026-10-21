import { MAX_FACT_CHARS } from "./fact-verifier";

/**
 * Basic facts from Wikidata and MusicBrainz, told in as few bubbles as fit.
 *
 * Viewers on a busy PC may see nothing but the instant data facts, so a
 * song's year and album read as one bubble, not two thin ones. Every value is
 * placed in a sentence exactly as the source gives it; no AI writes any of it.
 */

/** The combined sentence when it fits a bubble, else the separate sentences. */
export function fitOrSplit(combined: string, separate: string[]): string[] {
  return combined.length <= MAX_FACT_CHARS ? [combined] : separate;
}

/**
 * Sentences about one subject packed into bubbles of at most MAX_FACT_CHARS, in order.
 * `full` opens a bubble and names the subject; `short` follows it in the same bubble.
 */
export function packFacts(parts: Array<{ full: string; short: string }>): string[] {
  const bubbles: string[] = [];
  let open = "";
  for (const part of parts) {
    const joined = open ? `${open} ${part.short}` : "";
    if (open && joined.length <= MAX_FACT_CHARS) open = joined;
    else {
      if (open) bubbles.push(open);
      open = part.full;
    }
  }
  if (open) bubbles.push(open);
  return bubbles;
}

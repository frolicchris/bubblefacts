import { MAX_FACT_CHARS } from "./fact-verifier";

// Wikidata and MusicBrainz facts in as few bubbles as fit: on a busy PC they may be all a viewer sees
// Values placed as the source gives them, no AI (ARCHITECTURE.md: Where structured facts come from)

/** The combined sentence when it fits a bubble, else the separate ones */
export function fitOrSplit(combined: string, separate: string[]): string[] {
  return combined.length <= MAX_FACT_CHARS ? [combined] : separate;
}

/** One subject's sentences packed into bubbles, in order: `full` opens a bubble, `short` follows in it */
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

// Record labels: what an infobox or Wikidata puts in the label slot when there is no label
// (#586: "was released on Self-released."). A placeholder is never named as a label

const SELF_RELEASED = /^self[- ]?(released?|release|published|publishing)$/i;
const NO_LABEL = /^(self|independent|independent (release|music|label)|indie|none|no label|unsigned|n\/?a|diy|unknown|various)$/i;

/** True for "Self-released", "Independent", "None" and the like */
export function isPlaceholderLabel(name: string): boolean {
  const n = name.trim().replace(/\.$/, "");
  return SELF_RELEASED.test(n) || NO_LABEL.test(n);
}

/** The labels that are labels, and whether the list said self-released */
export function realLabels(names: string[]): { labels: string[]; selfReleased: boolean } {
  return {
    labels: names.filter((n) => !isPlaceholderLabel(n)),
    selfReleased: names.some((n) => SELF_RELEASED.test(n.trim().replace(/\.$/, ""))),
  };
}

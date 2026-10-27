import os from "os";

/**
 * Problem reports open GitHub's issue form in the browser, pre-filled, so the
 * musician sees exactly what's sent and submits it themselves. Secrets are
 * removed before anything leaves the app.
 */
const REPO = "https://github.com/frolicchris/bubblefacts";
const MAX_URL = 7000; // Browsers and GitHub reject much longer addresses.

export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("[removed]");
  return out
    .replace(/\b(sk-ant-[A-Za-z0-9_-]{10,}|gsk_[A-Za-z0-9]{10,})\b/g, "[removed]")
    .replace(/(Authorization:\s*\w+\s+)\S+/gi, "$1[removed]");
}

/**
 * `aired`: lines about facts that went out to the overlay, put after the log
 * under their own heading. The log is trimmed first; they go only if the
 * address still doesn't fit, oldest first.
 */
function issueUrl(template: string, fields: Record<string, string>, aired: { heading: string; lines: string[] } = { heading: "", lines: [] }): string {
  const lines = [...aired.lines];
  const build = () => {
    const tail = lines.length ? `${aired.heading}\n${lines.join("\n")}` : "";
    const log = [fields.log, tail].filter(Boolean).join("\n\n");
    return `${REPO}/issues/new?${new URLSearchParams({ template, ...fields, ...(log ? { log } : {}) })}`;
  };
  let url = build();
  // Trim the longest field (the log) until the address fits.
  while (url.length > MAX_URL && fields.log) {
    fields.log = fields.log.slice(Math.floor(fields.log.length * 0.25));
    url = build();
  }
  while (url.length > MAX_URL && lines.length) {
    lines.shift();
    url = build();
  }
  return url;
}

/** A fact that went out to the overlay, as the server keeps it (backend/src/aired-facts.ts). */
export interface AiredFact {
  title: string;
  artist: string;
  text: string;
  source?: string;
  url?: string;
  /** ISO date. */
  at: string;
}

/** The aired facts in what the server or the file gave, skipping anything that isn't one. */
export function airedFrom(data: unknown): AiredFact[] {
  const list = Array.isArray(data) ? data : Array.isArray((data as { facts?: unknown })?.facts) ? (data as { facts: unknown[] }).facts : [];
  return list.filter((e): e is AiredFact => {
    const a = e as AiredFact;
    return !!a && typeof a.title === "string" && typeof a.artist === "string" && typeof a.text === "string" && typeof a.at === "string"
      && (a.source === undefined || typeof a.source === "string") && (a.url === undefined || typeof a.url === "string");
  });
}

/** "2026-10-26 20:15 UTC", or the date as saved if it isn't one. */
function when(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const sourceOf = (a: AiredFact) => `${a.source ?? "no source"}${a.url ? `, ${a.url}` : ""}`;

/** One aired fact as a report line: `2026-10-26 20:15 UTC "Song" by Artist (source, link): text`. */
function airedLine(a: AiredFact): string {
  const artist = withoutArtistNote(a.artist);
  return `${when(a.at)} "${a.title}"${artist ? ` by ${artist}` : ""} (${sourceOf(a)}): ${a.text}`;
}

/** How many of the latest aired facts a problem report includes. */
export const PROBLEM_REPORT_AIRED = 10;

const osName = () => ({ darwin: "macOS", win32: "Windows" } as Record<string, string>)[process.platform] ?? "Linux";
const aiName = (ai: string) =>
  ({ builtin: "Built into the app", groq: "Groq", anthropic: "Anthropic", ollama: "Ollama on my computer" } as Record<string, string>)[ai] ??
  "Other or not sure";

/** `version` is the label with the build, such as "2.0.0-beta.12 test build (c4ee826)" (build.ts). */
export function problemReportUrl(opts: { version: string; ai: string; logLines: string[]; secrets: string[]; aired?: AiredFact[] }): string {
  const log = redact(opts.logLines.slice(-60).join("\n"), opts.secrets);
  const aired = (opts.aired ?? []).slice(-PROBLEM_REPORT_AIRED).map((a) => redact(airedLine(a), opts.secrets));
  return issueUrl(
    "bug_report.yml",
    {
      version: opts.version,
      install: "The desktop app",
      os: osName(),
      osversion: `${osName()} ${os.release()}, ${process.arch}`,
      ai: aiName(opts.ai),
      log,
    },
    { heading: "Latest facts on the overlay:", lines: aired }
  );
}

/**
 * The beta test form, with the answers the app knows filled in. Each dropdown answer must match a form
 * option exactly, so `version` is the plain version and `build` the label with the build (build.ts).
 */
export function betaReportUrl(opts: { version: string; build: string; systemVersion: string; songSource: string; nowPlayingPreset?: string; logLines: string[]; secrets: string[] }): string {
  const mac = process.arch === "arm64" ? "Mac with Apple silicon (M1 or newer)" : "Mac with Intel";
  const computer = ({ darwin: mac, win32: "Windows" } as Record<string, string>)[process.platform] ?? "Linux";
  const download =
    ({ darwin: "Mac installer (.dmg)", win32: "Windows installer (.exe)" } as Record<string, string>)[process.platform] ??
    (process.env.APPIMAGE ? "Linux AppImage" : "Linux .deb package");
  return issueUrl("beta_test.yml", {
    version: opts.version,
    build: opts.build,
    os: computer,
    download,
    source:
      opts.songSource === "nowplaying" && opts.nowPlayingPreset === "nightbot"
        ? "Now playing file (Nightbot)"
        : ({ streamelements: "StreamElements", nowplaying: "Now playing file" } as Record<string, string>)[opts.songSource] ?? "StreamerSongList",
    osversion: `${osName()} ${opts.systemVersion}`,
    log: redact(opts.logLines.slice(-60).join("\n"), opts.secrets),
  });
}

const REQUEST_CREDIT = /(?:^|[\s,;:|/([–—-])(?:commission(?:ed)?|requested|request|req\.?|suggested|sponsored|donated|gifted|paid)\s+(?:by|from)(?=\s|$)/i;
const FOR_CREDIT = /\s*[,;|–—]\s*for\s+(?=\S)|\s+-\s+for\s+(?=\S)/i;
const LEFT_OVER = /[\s,;:|/([–—-]/;

/** The artist without a note naming who asked or paid for the song: "Some Band, Commissioned by Name". */
function withoutRequestCredit(artist: string): string {
  const credit = REQUEST_CREDIT.exec(artist);
  const forName = FOR_CREDIT.exec(artist);
  const at = Math.min(credit ? credit.index : Infinity, forName ? forName.index : Infinity);
  if (at === Infinity) return artist.trim();
  let end = at;
  while (end > 0 && LEFT_OVER.test(artist[end - 1])) end--;
  return artist.slice(0, end).trim();
}

/**
 * The artist without the notes a song list adds after the name in brackets (issue #262):
 * "Some Band (note)" is "Some Band", and without a note naming who asked or paid for the
 * song. The same rule as `withoutArtistNote` in backend/src/text.ts, which the server
 * uses; keep them alike.
 */
export function withoutArtistNote(artist: string): string {
  let a = withoutRequestCredit(artist);
  for (;;) {
    const closer = a.endsWith(")") ? "(" : a.endsWith("]") ? "[" : "";
    const at = closer ? a.lastIndexOf(closer) : Math.max(a.lastIndexOf("("), a.lastIndexOf("["));
    if (at < 0 || (!closer && (a.includes(")", at) || a.includes("]", at)))) return a;
    const note = a.slice(at + 1).trimStart();
    const rest = a.slice(0, at).trim();
    if (note.startsWith("@") || !/[\p{L}\p{N}]/u.test(rest)) return a;
    a = rest;
  }
}

/** "Title — Artist (note)" as the dashboard labels a song, without the note: a report is public. */
function songLabel(label: string): string {
  const at = label.lastIndexOf(" — ");
  return at < 0 ? label : `${label.slice(0, at)} — ${withoutArtistNote(label.slice(at + 3))}`;
}

/**
 * The aired fact a Wrong report means, the newest with that text (for that song
 * when it can tell), and the other facts that went out with it: the entries
 * for the same song next to it in the record, which is in the order they aired.
 */
export function airedForReport(aired: AiredFact[], songTitle: string, fact: string): { reported: AiredFact | null; others: AiredFact[] } {
  const title = songTitle.toLowerCase();
  let at = -1;
  for (let i = aired.length - 1; i >= 0 && at < 0; i--) if (aired[i].text === fact && aired[i].title.toLowerCase() === title) at = i;
  for (let i = aired.length - 1; i >= 0 && at < 0; i--) if (aired[i].text === fact) at = i;
  if (at < 0) return { reported: null, others: [] };
  const reported = aired[at];
  const same = (a: AiredFact) => a.title === reported.title && a.artist === reported.artist;
  let first = at;
  let last = at;
  while (first > 0 && same(aired[first - 1])) first--;
  while (last < aired.length - 1 && same(aired[last + 1])) last++;
  const others = aired.slice(first, last + 1).filter((a, i, all) => a.text !== fact && all.findIndex((b) => b.text === a.text) === i);
  return { reported, others };
}

/** `version` is the label with the build (build.ts). */
export function wrongFactUrl(opts: { song: string; fact: string; version: string; logLines: string[]; secrets: string[]; aired?: AiredFact[] }): string {
  const songTitle = opts.song.split(" — ")[0];
  const title = songTitle.toLowerCase();
  const relevant = opts.logLines.filter((l) => /\[(Grounding|Screen)\]/.test(l) && l.toLowerCase().includes(title));
  const { reported, others } = airedForReport(opts.aired ?? [], songTitle, opts.fact);
  // The exact fact, with where it came from and when it aired, in the field that's never trimmed.
  const shown = reported
    ? [opts.fact, "", `Source: ${sourceOf(reported)}`, `On the overlay: ${when(reported.at)}`].join("\n")
    : opts.fact;
  return issueUrl(
    "wrong_fact.yml",
    {
      song: songLabel(opts.song),
      shown: redact(shown, opts.secrets),
      version: opts.version,
      log: redact((relevant.length ? relevant : opts.logLines.filter((l) => /\[Grounding\]/.test(l))).slice(-10).join("\n"), opts.secrets),
    },
    { heading: "Other facts on the overlay for this song:", lines: others.map((a) => redact(airedLine(a), opts.secrets)) }
  );
}

const LABELS: Record<string, string> = {
  version: "Version",
  install: "Installed as",
  os: "Computer",
  osversion: "System",
  ai: "AI",
  download: "Download",
  source: "Song source",
  song: "Song",
  shown: "Fact shown",
};

/**
 * A report as text to copy, for musicians without a GitHub account: exactly
 * the fields the GitHub form gets (secrets already removed), read back from
 * its address, so anything added to a report shows up here too.
 */
export function reportText(url: string, title: string): string {
  const fields = Object.fromEntries(new URL(url).searchParams);
  const lines = [title, ""];
  for (const [key, value] of Object.entries(fields)) {
    if (key === "template" || key === "log") continue;
    lines.push(`${LABELS[key] ?? key[0].toUpperCase() + key.slice(1)}: ${value}`);
  }
  if (fields.log) lines.push("", "Recent log:", fields.log);
  return lines.join("\n") + "\n";
}

export const problemReportText = (opts: Parameters<typeof problemReportUrl>[0]) => reportText(problemReportUrl(opts), "BubbleFacts problem report");
export const betaReportText = (opts: Parameters<typeof betaReportUrl>[0]) => reportText(betaReportUrl(opts), "BubbleFacts beta test report");

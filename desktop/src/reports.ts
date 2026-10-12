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

function issueUrl(template: string, fields: Record<string, string>): string {
  const params = new URLSearchParams({ template, ...fields });
  let url = `${REPO}/issues/new?${params}`;
  // Trim the longest field (the log) until the address fits.
  while (url.length > MAX_URL && fields.log) {
    fields.log = fields.log.slice(Math.floor(fields.log.length * 0.25));
    url = `${REPO}/issues/new?${new URLSearchParams({ template, ...fields })}`;
  }
  return url;
}

const osName = () => ({ darwin: "macOS", win32: "Windows" } as Record<string, string>)[process.platform] ?? "Linux";
const aiName = (ai: string) =>
  ({ builtin: "Built into the app", groq: "Groq", anthropic: "Anthropic", ollama: "Ollama on my computer" } as Record<string, string>)[ai] ??
  "Other or not sure";

/** `version` is the label with the build, such as "2.0.0-beta.12 test build (c4ee826)" (build.ts). */
export function problemReportUrl(opts: { version: string; ai: string; logLines: string[]; secrets: string[] }): string {
  const log = redact(opts.logLines.slice(-60).join("\n"), opts.secrets);
  return issueUrl("bug_report.yml", {
    version: opts.version,
    install: "The desktop app",
    os: osName(),
    osversion: `${osName()} ${os.release()}, ${process.arch}`,
    ai: aiName(opts.ai),
    log,
  });
}

/**
 * The beta test form, with the answers the app knows filled in. Each dropdown answer must match a form
 * option exactly, so `version` is the plain version and `build` the label with the build (build.ts).
 */
export function betaReportUrl(opts: { version: string; build: string; systemVersion: string; songSource: string; logLines: string[]; secrets: string[] }): string {
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
    source: opts.songSource === "streamelements" ? "StreamElements" : "StreamerSongList",
    osversion: `${osName()} ${opts.systemVersion}`,
    log: redact(opts.logLines.slice(-60).join("\n"), opts.secrets),
  });
}

/** `version` is the label with the build (build.ts). */
export function wrongFactUrl(opts: { song: string; fact: string; version: string; logLines: string[]; secrets: string[] }): string {
  const title = opts.song.split(" — ")[0].toLowerCase();
  const relevant = opts.logLines.filter((l) => /\[(Grounding|Screen)\]/.test(l) && l.toLowerCase().includes(title));
  return issueUrl("wrong_fact.yml", {
    song: opts.song,
    shown: opts.fact,
    version: opts.version,
    log: redact((relevant.length ? relevant : opts.logLines.filter((l) => /\[Grounding\]/.test(l))).slice(-10).join("\n"), opts.secrets),
  });
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

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

export function problemReportUrl(opts: { version: string; ai: string; logLines: string[]; secrets: string[] }): string {
  const log = redact(opts.logLines.slice(-60).join("\n"), opts.secrets);
  return issueUrl("bug_report.yml", {
    version: `${opts.version} (desktop app, ${osName()} ${os.release()}, ${process.arch})`,
    os: osName(),
    ai: aiName(opts.ai),
    log,
  });
}

export function wrongFactUrl(opts: { song: string; fact: string; logLines: string[]; secrets: string[] }): string {
  const title = opts.song.split(" — ")[0].toLowerCase();
  const relevant = opts.logLines.filter((l) => /\[(Grounding|Screen)\]/.test(l) && l.toLowerCase().includes(title));
  return issueUrl("wrong_fact.yml", {
    song: opts.song,
    shown: opts.fact,
    log: redact((relevant.length ? relevant : opts.logLines.filter((l) => /\[Grounding\]/.test(l))).slice(-10).join("\n"), opts.secrets),
  });
}

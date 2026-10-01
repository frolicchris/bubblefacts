import fs from "fs";
import path from "path";
import { betaReportUrl, problemReportUrl, redact, wrongFactUrl } from "./reports";

const decode = (url: string) => Object.fromEntries(new URL(url).searchParams);

describe("redact", () => {
  it("removes the musician's secrets and anything that looks like a key or token", () => {
    const text = [
      "token my-ssl-token-123 in a line",
      "key sk-ant-abcdefghijklmnop and gsk_abcdefghijklmnop",
      "Authorization: Bearer abc.def.ghi",
    ].join("\n");
    const out = redact(text, ["my-ssl-token-123"]);
    expect(out).not.toMatch(/my-ssl-token-123|sk-ant-abc|gsk_abc|abc\.def\.ghi/);
    expect(out).toContain("Authorization: Bearer [removed]");
  });
});

describe("problem reports", () => {
  it("fills the bug form without secrets, and fits in a web address", () => {
    const lines = Array.from({ length: 800 }, (_, i) => `[Server] line ${i} with secret-token-xyz ${"x".repeat(60)}`);
    const url = problemReportUrl({ version: "2.0.0", ai: "builtin", logLines: lines, secrets: ["secret-token-xyz"] });
    expect(url.length).toBeLessThanOrEqual(7000);
    const fields = decode(url);
    expect(fields.template).toBe("bug_report.yml");
    expect(fields.ai).toBe("Built into the app");
    expect(fields.log).not.toContain("secret-token-xyz");
    expect(fields.log).toContain("line 799");
  });

  it("sends the lookup lines for the song a wrong fact came from", () => {
    const lines = [
      '[Grounding] "Other Song": article X',
      '[Grounding] "Clair de Lune": article Clair de lune (Debussy)',
      '[Screen] "Clair de Lune": 6 generated, 1 dropped, 5 shown',
      "[Server] unrelated",
    ];
    const fields = decode(wrongFactUrl({ song: "Clair de Lune — Debussy", fact: "A fact.", logLines: lines, secrets: [] }));
    expect(fields).toMatchObject({ template: "wrong_fact.yml", song: "Clair de Lune — Debussy", shown: "A fact." });
    expect(fields.log).toContain("Clair de lune (Debussy)");
    expect(fields.log).not.toContain("Other Song");
  });
});

describe("beta test reports", () => {
  const root = path.join(__dirname, "../..");
  const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
  const form = fs.readFileSync(path.join(root, ".github/ISSUE_TEMPLATE/beta_test.yml"), "utf8");
  /** A dropdown's options: the "- " lines under its "options:", up to the next field. */
  const options = (id: string) => {
    const field = form.split(/\n  - type: /).find((f) => f.includes(`id: ${id}\n`)) ?? "";
    const list = field.split(/\n\s+options:\n/)[1] ?? "";
    return list.split("\n").map((l) => /^\s+- (.+)$/.exec(l)?.[1]).filter(Boolean);
  };

  it("fills only answers the form offers, so GitHub selects them", () => {
    const fields = decode(betaReportUrl({ version, systemVersion: "15.3.0", songSource: "streamelements", logLines: ["x"], secrets: [] }));
    expect(fields.template).toBe("beta_test.yml");
    for (const id of ["os", "download", "source"]) expect(options(id)).toContain(fields[id]);
    expect(fields.source).toBe("StreamElements");
  });

  it("lists this version, newest first, while it's a beta", () => {
    if (version.includes("-beta")) expect(options("version")[0]).toBe(version);
  });
});

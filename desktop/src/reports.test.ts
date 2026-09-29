import { problemReportUrl, redact, wrongFactUrl } from "./reports";

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

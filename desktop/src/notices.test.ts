import fs from "fs";
import path from "path";

const root = path.resolve(__dirname, "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
  build: { files: string[]; copyright: string };
};
const notices = fs.readFileSync(path.join(root, "THIRD-PARTY-NOTICES.md"), "utf8");

describe("licenses shipped with the app", () => {
  it("lists every dependency in THIRD-PARTY-NOTICES.md (run scripts/third-party-notices.mjs)", () => {
    const missing = Object.keys(pkg.dependencies).filter((name) => !notices.includes(`### ${name} `));
    expect(missing).toEqual([]);
  });

  it("puts the notices and the license in the app, and names the license in its copyright", () => {
    expect(pkg.build.files).toEqual(expect.arrayContaining(["LICENSE", "THIRD-PARTY-NOTICES.md"]));
    expect(pkg.build.copyright).toMatch(/Christopher Feyrer.*MIT License/);
  });
});

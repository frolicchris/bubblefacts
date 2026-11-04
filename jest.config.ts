import type { Config } from "jest";

/** Transpile-only (diagnostics off): `npm run typecheck` is the type gate. */
const project = {
  testEnvironment: "node",
  // Routine log output is noise in test runs; tests that expect an error spy on console.error.
  setupFiles: ["<rootDir>/backend/src/test-setup.ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "backend/tsconfig.json", diagnostics: false }] as [string, Record<string, unknown>],
  },
};

/** The article-match tests, run again with MATCH=rules, the fallback to the scored match (issue #172). */
const MATCH_TESTS = ["wrong-work", "work-match", "summary-gate", "work-scope", "performer-article", "same-name-artist"];

const config: Config = {
  collectCoverageFrom: ["backend/src/**/*.ts", "desktop/src/**/*.ts", "!**/*.test.ts"],
  projects: [
    { ...project, displayName: "all", roots: ["<rootDir>/backend/src", "<rootDir>/desktop/src"], testMatch: ["**/*.test.ts"] },
    {
      ...project,
      displayName: "rules match",
      roots: ["<rootDir>/backend/src"],
      testMatch: MATCH_TESTS.map((name) => `**/${name}.test.ts`),
      setupFiles: [...project.setupFiles, "<rootDir>/backend/src/rules-match-setup.ts"],
    },
  ],
};

export default config;

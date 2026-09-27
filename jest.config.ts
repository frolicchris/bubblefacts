import type { Config } from "jest";

/**
 * Transpile-only. ts-jest type-checks every file by default, which made a
 * single suite take over three minutes on this machine — long enough that
 * runs were routinely abandoned, which is worse than no tests.
 *
 * Nothing is lost: `tsc -p backend/tsconfig.json --noEmit` already
 * type-checks the whole backend, it runs in the build and in the preflight,
 * and it is the gate the peer-review script uses. Jest's job here is to run
 * assertions, not to re-do that work per test file.
 */
const config: Config = {
  testEnvironment: "node",
  roots: ["<rootDir>/backend/src"],
  testMatch: ["**/*.test.ts"],
  collectCoverageFrom: ["backend/src/**/*.ts", "!backend/src/**/*.test.ts"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { isolatedModules: true, diagnostics: false }],
  },
};

export default config;

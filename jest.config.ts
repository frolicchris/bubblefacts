import type { Config } from "jest";

/** Transpile-only (diagnostics off): `npm run typecheck` is the type gate. */
const config: Config = {
  testEnvironment: "node",
  roots: ["<rootDir>/backend/src", "<rootDir>/desktop/src"],
  testMatch: ["**/*.test.ts"],
  // Routine log output is noise in test runs; tests that expect an error spy on console.error.
  setupFiles: ["<rootDir>/backend/src/test-setup.ts"],
  collectCoverageFrom: ["backend/src/**/*.ts", "desktop/src/**/*.ts", "!**/*.test.ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "backend/tsconfig.json", diagnostics: false }],
  },
};

export default config;

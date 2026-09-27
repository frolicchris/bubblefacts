/**
 * ESLint flat config.
 *
 * There was no config file at all, so `npm run lint` had been failing with a
 * migration notice on every run — and the peer-review script's pass check
 * greps for the word "error", which that notice does not contain, so every
 * check-in reported "Lint: PASS" while linting nothing.
 *
 * Scope is deliberately the browser JS. TypeScript is
 * left to `tsc --noEmit`, which already type-checks the whole backend on
 * every build and catches strictly more than a lint pass would here; adding
 * typescript-eslint would mean new dependencies for overlapping coverage.
 */
export default [
  {
    files: ["frontend/**/*.js"],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: "script",
      globals: {
        window: "readonly",
        document: "readonly",
        console: "readonly",
        location: "readonly",
        WebSocket: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        requestAnimationFrame: "readonly",
        Date: "readonly",
        JSON: "readonly",
        Math: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["warn", { args: "none" }],
      "no-redeclare": "error",
      "no-dupe-keys": "error",
      "no-unreachable": "error",
      // The overlay runs in OBS's CEF where a thrown error kills the whole
      // page, so an accidental global or shadowed binding is worth failing on.
      "no-implicit-globals": "error",
    },
  },
];

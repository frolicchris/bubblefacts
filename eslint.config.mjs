/**
 * Lints the overlay, which runs as a plain browser script inside OBS, and
 * the Node scripts in scripts/.
 * The TypeScript backend is checked by `npm run typecheck` (strict mode
 * plus the unused-code flags in backend/tsconfig.json).
 */
export default [
  {
    files: ["frontend/**/*.js", "desktop/renderer/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        window: "readonly",
        document: "readonly",
        location: "readonly",
        WebSocket: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": "error",
      "no-implicit-globals": "error",
      "no-redeclare": "error",
      "no-shadow": "error",
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: "error",
      strict: ["error", "function"],
      "no-console": "error",
      curly: ["error", "multi-line"],
    },
  },
  {
    // The release, build and check scripts: Node modules, which print to the terminal.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        fetch: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        structuredClone: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": "error",
      "no-redeclare": "error",
      "no-shadow": "error",
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: "error",
      curly: ["error", "multi-line"],
    },
  },
];

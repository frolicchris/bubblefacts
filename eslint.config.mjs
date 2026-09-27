/**
 * Lints the overlay, which runs as a plain browser script inside OBS.
 * The TypeScript backend is checked by `npm run typecheck` (strict mode
 * plus the unused-code flags in backend/tsconfig.json).
 */
export default [
  {
    files: ["frontend/**/*.js"],
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
];

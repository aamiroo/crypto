import coreWebVitals from "eslint-config-next/core-web-vitals";

// ESLint 9 + eslint-config-next 16 read this file instead of `.eslintrc.json`.
// `core-web-vitals` already includes `next/typescript`, so the old two-entry
// `extends` list is one spread here.
const config = [
  { ignores: [".next/", "node_modules/", "next-env.d.ts"] },
  ...coreWebVitals,
  {
    // Scoped to TS: the plugin that owns the rule is only registered there.
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
];

export default config;

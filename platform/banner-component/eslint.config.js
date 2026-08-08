import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "scripts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // The hostile-env suite is the only plain-JS under tests/ — everything
  // else is TypeScript, where typescript-eslint turns `no-undef` off
  // because the compiler already catches it. These files get no such
  // treatment, which is why they were the whole reason `lint` skipped
  // tests/ entirely.
  //
  // Both environments, deliberately: run.mjs is a Node script (process,
  // console) that also contains Playwright page.evaluate() bodies —
  // those execute in the browser but are lexically inside the .mjs, so
  // `document` and `getComputedStyle` are genuinely in scope there. The
  // fixtures are browser-context seed scripts.
  {
    files: ["tests/hostile/**/*.{js,mjs}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
);

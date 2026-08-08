import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    ignores: ["dist/**", "node_modules/**", "eslint.config.js"],
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Business logic throughout this codebase intentionally uses
      // `unknown`/loosely-typed provider responses at integration
      // boundaries (SMTP responses, provider payloads); `any` still
      // shows up there. Warn rather than block CI on it for now
      // rather than requiring a large, risky rewrite as part of an
      // infrastructure change.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": "off",

      // This class of bug is exactly why this rule is worth the
      // type-aware linting cost: an async repository method called
      // without `await` compiles cleanly (it's valid JS to discard a
      // Promise) but silently races with whatever runs next — e.g. a
      // foreign-key insert that depends on the discarded write having
      // already committed. Caught a real ordering bug in the
      // verification orchestrator during this change; keeping it on
      // as an error so it can't regress silently.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",

      // Loosened from the type-checked preset's defaults: this
      // codebase passes `unknown` provider/DB payloads through
      // several boundary layers before narrowing them, which the
      // strict unsafe-* rules flag heavily without catching real
      // bugs. Revisit if the codebase moves toward stricter typing
      // at those boundaries.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",

      // Fastify plugin/route-registration functions are idiomatically
      // declared `async` even when a given handler has no internal
      // `await` (Fastify awaits the returned value/plugin promise
      // either way). Flagging every such handler is noise, not signal.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    // node:test's test() takes an async callback and returns a
    // Promise that the test runner itself awaits/tracks — it is not
    // a floating promise in the sense this rule exists to catch.
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
    },
  }
);

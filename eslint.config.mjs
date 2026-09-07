import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/**", "dist/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["apps/console/**/*.js", "apps/inquiry/**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: Object.fromEntries(["document", "window", "location", "navigator", "fetch", "Headers", "URL", "URLSearchParams", "FormData", "Blob", "crypto", "CSS", "HTMLElement", "AbortController", "AbortSignal", "matchMedia", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "confirm", "alert", "console", "localStorage", "sessionStorage", "structuredClone", "queueMicrotask"].map((name) => [name, "readonly"])),
    },
  },
  {
    files: ["apps/console/developer.js"],
    // Drop credential references promptly, including error and finally paths.
    rules: { "no-useless-assignment": "off" },
  },
  {
    files: ["deploy/portal/**/*.mjs", "deploy/scripts/build.mjs", "deploy/scripts/build-inquiry.mjs", "deploy/cli/**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: Object.fromEntries(["process", "console", "Buffer", "URL", "setTimeout", "clearTimeout"].map((name) => [name, "readonly"])),
    },
  },
  {
    files: ["tests/e2e/portal-browser/**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: Object.fromEntries(["process", "console", "fetch", "URL", "setTimeout", "clearTimeout", "AbortSignal", "document", "window", "location", "innerWidth", "crypto", "FormData"].map((name) => [name, "readonly"])),
    },
  },
  {
    files: ["src/**/*.ts", "services/**/*.ts", "tests/**/*.ts", "apps/inquiry/**/*.ts", "deploy/cli/**/*.ts", "deploy/scripts/start-portal-fixture.ts", "deploy/scripts/generate-case-schemas.ts", "deploy/scripts/generate-business-schemas.ts", "deploy/scripts/generate-portal-openapi.ts", "vitest.config.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);

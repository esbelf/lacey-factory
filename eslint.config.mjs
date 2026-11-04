import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["**/dist/**", "**/node_modules/**", "api/drizzle/**"]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["api/**/*.{ts,mts,mjs}", "shared/**/*.ts", "*.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["web/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    files: ["auth0/**/*.js"],
    languageOptions: { globals: globals.node, sourceType: "commonjs" },
  },
]);

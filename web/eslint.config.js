import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "coverage", "playwright-report", "test-results", ".wrangler"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.node.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-restricted-properties": [
        "error",
        { object: "document", property: "write", message: "Build DOM nodes instead." },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "AssignmentExpression[left.property.name=/^(innerHTML|outerHTML)$/]",
          message:
            "Data comes from third parties: use textContent or DOM nodes, never HTML strings.",
        },
        {
          selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
          message: "Data comes from third parties: use DOM nodes, never HTML strings.",
        },
      ],
    },
  },
  {
    files: ["*.js", "*.mjs", "scripts/**"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { ...globals.node } },
  },
);

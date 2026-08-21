import eslint from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/"] },
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettierConfig,
  // After prettierConfig: eslint-config-prettier turns `curly` off as one of
  // its "special rules", but the "all" option never conflicts with Prettier.
  {
    files: ["**/*.ts"],
    rules: {
      curly: ["error", "all"],
      "padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "*", next: "return" },
        { blankLine: "always", prev: "block-like", next: "*" },
        { blankLine: "always", prev: "*", next: "block-like" },
      ],
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        { allowExpressions: true },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "TSAsExpression > TSTypeReference > Identifier[name='const']",
          message:
            "Do not use `as const`; declare an explicit type instead (e.g. annotate the function's return type).",
        },
        {
          selector:
            "TSInterfaceBody > TSPropertySignature:not([readonly=true])",
          message:
            "Interface properties must be `readonly`. Where mutation is part of the contract, add an eslint-disable comment stating why.",
        },
      ],
    },
  },
);

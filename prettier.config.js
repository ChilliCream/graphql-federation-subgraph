/** @type {import('prettier').Config} */
export default {
  singleQuote: false,
  // The federation SDL in src/type-defs.ts must stay verbatim from the spec;
  // embedded formatting would rewrite the exported string.
  embeddedLanguageFormatting: "off",
};

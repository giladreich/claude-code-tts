// What the machine checks, so a review can be about the code.
//
// Two jobs, kept apart: Prettier decides how the code is laid out (one
// config, no arguments), and this decides what may be written. The rules
// here are the ones that caught real bugs in this codebase or answer a
// question that came up twice: a promise nobody awaited, a variable left
// behind by a refactor, and the blank line between one function and the next.
import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["out/**", "node_modules/**", "assets/**", "*.vsix"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: { project: "./tsconfig.json", tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@stylistic": stylistic },
    rules: {
      // Braces on every branch, however short. A body without them is one
      // careless line away from being outside the branch it looks part of,
      // and the reader has to check which shape they are looking at.
      curly: ["error", "all"],
      // A catch that deliberately does nothing is an idiom here (a file that
      // vanished mid-scan, a temp file already gone); an empty if or for is not.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // A promise nobody waits for is a flow that runs after the window has
      // moved on. Where that is deliberate the code says so with `void`.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      // Anything left behind by a refactor, with the usual escape hatch for
      // arguments a signature has to keep.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // These read as noise in a codebase that talks to VSCode's untyped API.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/require-await": "off",
      // One blank line between one declaration and the next, which is the
      // thing a person notices first when a file has been cut up.
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "*", next: "function" },
        { blankLine: "always", prev: "function", next: "*" },
        { blankLine: "always", prev: "*", next: "class" },
        { blankLine: "always", prev: "class", next: "*" },
        { blankLine: "always", prev: "*", next: "export" },
        // No exemption for two exports in a row: the pair that hid behind it
        // was an exported function followed by another exported function.
        { blankLine: "always", prev: "export", next: "export" },
        { blankLine: "any", prev: "import", next: "import" },
      ],
    },
  },
  { files: ["test/**/*.js", "*.mjs"], ...tseslint.configs.disableTypeChecked },
  {
    // The tests are plain JavaScript with no TypeScript project behind them,
    // so the rules that need a type checker are off for them (above).
    files: ["test/**/*.js", "*.mjs"],
    languageOptions: { globals: { require: "readonly", module: "writable", process: "readonly", __dirname: "readonly", console: "readonly", Buffer: "readonly", setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly", setImmediate: "readonly", queueMicrotask: "readonly" } },
    rules: {
      // CommonJS on purpose: the tests load the compiled output the way the
      // extension host does, and swap modules in the require cache.
      "@typescript-eslint/no-require-imports": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  prettier,
  {
    // Last word, after the Prettier config: it turns `curly` off because the
    // rule can fight a formatter when set to "multi-line". Set to "all" it
    // cannot, and braces on every branch is a rule of this codebase.
    files: ["src/**/*.ts"],
    rules: { curly: ["error", "all"] },
  }
);

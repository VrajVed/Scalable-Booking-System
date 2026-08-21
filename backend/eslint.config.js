import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  {
    files: ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts"],
    extends: [tseslint.configs.recommended],
    rules: {
      // This codebase already uses a leading underscore for intentionally
      // unused params (e.g. Fastify preHandlers that don't need `reply`) --
      // without this, the recommended preset flags every one of those as an
      // error instead of recognizing the existing convention.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);

// ESLint flat config（开工轮一审 D3：直接依赖+显式配置，不靠 --if-present 静默跳过）
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/*.js",
      "**/*.d.ts",
      "**/*.js.map",
      "**/*.tsbuildinfo",
      "apps/web/**", // UI 切片（GPT）自帶檢查，合入后再纳管
    ],
  },
  ...tseslint.configs.recommended.map((c) => ({
    ...c,
    files: ["**/*.ts"],
  })),
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);

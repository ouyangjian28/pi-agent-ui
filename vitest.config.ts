import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts", "packages/*/src/**/*.test.ts"],
          environment: "node" as const,
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node" as const,
          // CI 分层：vitest run --project unit 快跑；integration 本机/发布前跑（真 pi 子进程）
        },
      },
    ],
  },
});

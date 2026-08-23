import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
  resolve: {
    alias: {
      "@opencanvas/shared/research-repository": path.resolve(
        __dirname,
        "../../packages/shared/src/research-repository.ts"
      ),
      "@opencanvas/shared/github-research/crypto": path.resolve(
        __dirname,
        "../../packages/shared/src/github-research/crypto.ts"
      ),
      "@": path.resolve(__dirname, "./src"),
    },
  },
});

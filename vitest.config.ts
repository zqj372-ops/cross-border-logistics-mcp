import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Build integration tests replace the shared dist directory. Running test
    // files concurrently can remove another test's assets while it reads them.
    fileParallelism: false,
  },
});

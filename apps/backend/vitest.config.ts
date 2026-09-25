import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 180_000,
    // Every integration file boots its own embedded PostgreSQL; serializing the
    // files keeps six Postgres instances and their migration/seed work from
    // competing for CPU and connections in parallel workers.
    fileParallelism: false,
  },
});
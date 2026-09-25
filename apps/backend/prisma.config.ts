import { defineConfig } from "prisma/config";
import "dotenv/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5432/callnotes?schema=public",
  },
  migrations: {
    path: "prisma/migrations",
    seed: "node prisma/seed.mjs",
  },
});
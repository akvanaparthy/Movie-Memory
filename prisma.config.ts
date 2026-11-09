import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

// Prisma 7 no longer loads .env for the CLI. Node's built-in loader does it
// locally; on Vercel there is no .env file and the variables are already set.
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    // Migrations use the direct (unpooled) Neon connection, falling back to
    // DATABASE_URL for a plain local Postgres that has only one URL. Read
    // directly rather than via env() so `prisma generate` (postinstall) still
    // works when no database is configured.
    url: process.env.DIRECT_URL || process.env.DATABASE_URL,
  },
});

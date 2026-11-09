import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { getEnv } from "@/lib/env";

export type Db = PrismaClient;

export function createDb(connectionString: string): Db {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

// One client per process. Kept on globalThis so dev hot reloads do not open a
// new connection pool on every edit. Created on first use so that importing
// this module never requires DATABASE_URL (builds, tests).
const globalForDb = globalThis as unknown as { db?: Db };

export function getDb(): Db {
  globalForDb.db ??= createDb(getEnv("DATABASE_URL"));
  return globalForDb.db;
}

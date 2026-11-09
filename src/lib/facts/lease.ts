import type { Db } from "@/lib/db";

/**
 * The burst guard: one `FactLease` row per user, and only its holder may call
 * OpenAI for that user.
 *
 * Times are passed in from the app clock rather than using the database's
 * `now()`, so the lease, `Fact.createdAt` and the freshness check all use one
 * clock. With several server instances this assumes their clocks agree to
 * well within the lease TTL, which NTP-synced hosts do.
 */

/**
 * Take the lease in a single atomic statement. A row comes back when we
 * inserted a new lease or took over an expired one; no row means a live lease
 * belongs to someone else. Two concurrent callers cannot both win: Postgres
 * serializes them on the primary key, and the loser's conflict check sees the
 * winner's unexpired lease.
 *
 * Timestamps are sent as ISO strings cast to `timestamp`. The column has no
 * time zone and Prisma stores UTC in it; casting an ISO string to `timestamp`
 * keeps the UTC wall time regardless of the connection's TimeZone setting.
 */
export async function tryAcquireLease(
  db: Db,
  userId: string,
  token: string,
  now: Date,
  ttlMs: number,
): Promise<boolean> {
  const nowIso = now.toISOString();
  const expiresIso = new Date(now.getTime() + ttlMs).toISOString();
  const rows = await db.$queryRaw<{ token: string }[]>`
    INSERT INTO "FactLease" ("userId", "token", "expiresAt")
    VALUES (${userId}, ${token}, ${expiresIso}::timestamp)
    ON CONFLICT ("userId") DO UPDATE
      SET "token" = EXCLUDED."token", "expiresAt" = EXCLUDED."expiresAt"
      WHERE "FactLease"."expiresAt" <= ${nowIso}::timestamp
    RETURNING "token"
  `;
  return rows.length === 1;
}

/** Release only our own lease: if it expired and was taken over, leave it. */
export async function releaseLease(db: Db, userId: string, token: string): Promise<void> {
  await db.factLease.deleteMany({ where: { userId, token } });
}

/** Whether someone currently holds a live (unexpired) lease for this user. */
export async function isLeaseHeld(db: Db, userId: string, now: Date): Promise<boolean> {
  const lease = await db.factLease.findUnique({ where: { userId }, select: { expiresAt: true } });
  return lease !== null && lease.expiresAt > now;
}

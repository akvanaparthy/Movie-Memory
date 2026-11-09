import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db";
import type { FactStatus, FactSuccess } from "./contract";
import { freshForMs, isFresh } from "./freshness";
import type { FactGenerator } from "./generate";
import { isLeaseHeld, releaseLease, tryAcquireLease } from "./lease";
import { DEFAULT_TIMINGS, type FactTimings } from "./timings";

export type FactOutcome =
  | { type: "success"; body: FactSuccess }
  | { type: "no_movie" }
  | { type: "generation_failed" };

/** Everything getFact touches, injectable so tests need no real OpenAI. */
export type FactDeps = {
  db: Db;
  /** The app clock: used both to stamp `createdAt` and to judge freshness. */
  now: () => Date;
  generate: FactGenerator;
  timings?: FactTimings;
  sleep?: (ms: number) => Promise<void>;
};

type FactRow = { id: string; movie: string; text: string; createdAt: Date };

/**
 * Returns a fact for the user's current favorite movie:
 *
 * 1. A fact younger than the cache window is served as `cached`.
 * 2. Otherwise one request per user takes the lease and generates (`fresh`).
 * 3. Concurrent requests wait for that one and get its fact as `cached`, so a
 *    burst costs exactly one OpenAI call, even while OpenAI is failing.
 * 4. If generation fails, the latest older fact is served as `stale`.
 */
export async function getFact(userId: string, deps: FactDeps): Promise<FactOutcome> {
  const { db, now } = deps;

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { favoriteMovie: true },
  });
  const movie = user?.favoriteMovie;
  if (!movie) return { type: "no_movie" };

  const latest = await findLatestFact(db, userId, movie);
  if (latest && isFresh(latest.createdAt, now())) return success(latest, "cached", now());

  const timings = deps.timings ?? DEFAULT_TIMINGS;
  const token = randomUUID();
  if (await tryAcquireLease(db, userId, token, now(), timings.leaseTtlMs)) {
    try {
      return await generateAsHolder(userId, movie, deps);
    } finally {
      await releaseLease(db, userId, token);
    }
  }
  return waitForHolder(userId, movie, deps, timings);
}

async function generateAsHolder(userId: string, movie: string, deps: FactDeps): Promise<FactOutcome> {
  const { db, now } = deps;

  // Another request may have finished generating between our first check and
  // taking the lease.
  const latest = await findLatestFact(db, userId, movie);
  if (latest && isFresh(latest.createdAt, now())) return success(latest, "cached", now());

  // Deliberately outside any transaction: holding a DB transaction open for a
  // multi-second network call would pin a pooled connection for no benefit.
  let generated;
  try {
    generated = await deps.generate(movie);
  } catch (error) {
    console.error("Fact generation failed", { userId, error });
    return fallback(userId, movie, deps);
  }

  const fact = await db.fact.create({
    data: { userId, movie, text: generated.text, model: generated.model, createdAt: now() },
    select: factSelect,
  });
  return success(fact, "fresh", now());
}

/** Waiters never call the generator; they only watch for the holder's result. */
async function waitForHolder(
  userId: string,
  movie: string,
  deps: FactDeps,
  timings: FactTimings,
): Promise<FactOutcome> {
  const { db, now } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = now().getTime() + timings.waitDeadlineMs;

  while (now().getTime() < deadline) {
    await sleep(timings.pollIntervalMs);

    const latest = await findLatestFact(db, userId, movie);
    if (latest && isFresh(latest.createdAt, now())) return success(latest, "cached", now());

    // The holder is done (or its lease expired) and left no fresh fact.
    if (!(await isLeaseHeld(db, userId, now()))) break;
  }
  return fallback(userId, movie, deps);
}

/**
 * The failure path, shared by a failed holder and by waiters that gave up.
 * It checks freshness once more because a waiter can see the lease released
 * just after the holder wrote its fact.
 */
async function fallback(userId: string, movie: string, deps: FactDeps): Promise<FactOutcome> {
  const latest = await findLatestFact(deps.db, userId, movie);
  if (!latest) return { type: "generation_failed" };
  const now = deps.now();
  return success(latest, isFresh(latest.createdAt, now) ? "cached" : "stale", now);
}

const factSelect = { id: true, movie: true, text: true, createdAt: true } as const;

// Always scoped by userId: a fact is never shared between users, even for the
// same movie title.
function findLatestFact(db: Db, userId: string, movie: string): Promise<FactRow | null> {
  return db.fact.findFirst({
    where: { userId, movie },
    orderBy: { createdAt: "desc" },
    select: factSelect,
  });
}

function success(fact: FactRow, status: FactStatus, now: Date): FactOutcome {
  return {
    type: "success",
    body: {
      fact: {
        id: fact.id,
        movie: fact.movie,
        text: fact.text,
        createdAt: fact.createdAt.toISOString(),
      },
      status,
      freshForMs: status === "stale" ? 0 : freshForMs(fact.createdAt, now),
    },
  };
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

import { FACT_CACHE_WINDOW_MS } from "./contract";

/**
 * Milliseconds left in the cache window: 0 once it has closed, and never more
 * than the window itself. The upper bound matters when a fact was stamped by
 * a server whose clock runs ahead of this one: its age is negative here.
 */
export function freshForMs(createdAt: Date, now: Date): number {
  const age = now.getTime() - createdAt.getTime();
  return Math.min(FACT_CACHE_WINDOW_MS, Math.max(0, FACT_CACHE_WINDOW_MS - age));
}

/**
 * A fact is fresh while it is strictly younger than the window: at exactly
 * 60 000 ms it is no longer fresh.
 */
export function isFresh(createdAt: Date, now: Date): boolean {
  return freshForMs(createdAt, now) > 0;
}

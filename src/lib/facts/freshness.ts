import { FACT_CACHE_WINDOW_MS } from "./contract";

/** Milliseconds left in the cache window; 0 once the window has closed. */
export function freshForMs(createdAt: Date, now: Date): number {
  const age = now.getTime() - createdAt.getTime();
  return Math.max(0, FACT_CACHE_WINDOW_MS - age);
}

/**
 * A fact is fresh while it is strictly younger than the window: at exactly
 * 60 000 ms it is no longer fresh.
 */
export function isFresh(createdAt: Date, now: Date): boolean {
  return freshForMs(createdAt, now) > 0;
}

import { describe, expect, it } from "vitest";
import { FACT_CACHE_WINDOW_MS } from "@/lib/facts/contract";
import { freshForMs, isFresh } from "@/lib/facts/freshness";

const NOW = new Date("2026-01-01T12:00:00.000Z");
const aged = (ms: number) => new Date(NOW.getTime() - ms);

describe("freshness", () => {
  it.each([
    [0, FACT_CACHE_WINDOW_MS, true],
    [1, FACT_CACHE_WINDOW_MS - 1, true],
    [FACT_CACHE_WINDOW_MS - 1, 1, true],
    [FACT_CACHE_WINDOW_MS, 0, false],
    [FACT_CACHE_WINDOW_MS + 1, 0, false],
    [24 * 60 * 60 * 1000, 0, false],
  ])("a fact %i ms old has %i ms left (fresh: %s)", (age, left, fresh) => {
    expect(freshForMs(aged(age), NOW)).toBe(left);
    expect(isFresh(aged(age), NOW)).toBe(fresh);
  });

  // Two server instances never agree on the time exactly. A fact stamped by
  // the faster clock looks like it is from the future to the slower one. It
  // must still count as fresh, and must never report more time left than the
  // window is long (the UI draws its progress line from this number).
  it("treats a fact stamped slightly in the future as fresh for at most the window", () => {
    const fromAFasterClock = new Date(NOW.getTime() + 5_000);

    expect(isFresh(fromAFasterClock, NOW)).toBe(true);
    expect(freshForMs(fromAFasterClock, NOW)).toBe(FACT_CACHE_WINDOW_MS);
  });
});

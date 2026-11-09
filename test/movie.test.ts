import { describe, expect, it } from "vitest";
import { MOVIE_TITLE_MAX, parseMovieTitle } from "@/lib/movie";

describe("parseMovieTitle", () => {
  it("trims surrounding whitespace", () => {
    expect(parseMovieTitle("  Alien  ")).toEqual({ ok: true, title: "Alien" });
  });

  it("collapses internal whitespace runs to one space", () => {
    expect(parseMovieTitle("The \t Grand\n\nBudapest   Hotel")).toEqual({
      ok: true,
      title: "The Grand Budapest Hotel",
    });
  });

  it("rejects empty and whitespace-only input", () => {
    expect(parseMovieTitle("")).toEqual({ ok: false, error: "Please enter a movie title." });
    expect(parseMovieTitle("   ")).toEqual({ ok: false, error: "Please enter a movie title." });
  });

  it("rejects non-string input with the same friendly message", () => {
    expect(parseMovieTitle(null)).toEqual({ ok: false, error: "Please enter a movie title." });
  });

  it("enforces the maximum on the cleaned title", () => {
    expect(parseMovieTitle("a".repeat(MOVIE_TITLE_MAX))).toMatchObject({ ok: true });
    expect(parseMovieTitle("a".repeat(MOVIE_TITLE_MAX + 1))).toMatchObject({ ok: false });
    // Padding does not count against the limit.
    expect(parseMovieTitle(`  ${"a".repeat(MOVIE_TITLE_MAX)}  `)).toMatchObject({ ok: true });
  });
});

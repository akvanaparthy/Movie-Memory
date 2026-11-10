import { describe, expect, it } from "vitest";
import { MOVIE_TITLE_MAX, parseMovieTitle } from "@/lib/movie";

const EMPTY = { ok: false, error: "Please enter a movie title." };

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
    expect(parseMovieTitle("")).toEqual(EMPTY);
    expect(parseMovieTitle("   ")).toEqual(EMPTY);
    expect(parseMovieTitle("\t\n\r")).toEqual(EMPTY);
    // Non-breaking and other Unicode spaces are still just spaces.
    expect(parseMovieTitle("  　")).toEqual(EMPTY);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["an object", { title: "Alien" }],
    ["an array", ["Alien"]],
    ["an uploaded file", new File(["Alien"], "movie.txt")],
  ])("rejects %s with the same friendly message", (_label, input) => {
    expect(parseMovieTitle(input)).toEqual(EMPTY);
  });

  it("enforces the maximum on the cleaned title", () => {
    expect(parseMovieTitle("a".repeat(MOVIE_TITLE_MAX))).toMatchObject({ ok: true });
    expect(parseMovieTitle("a".repeat(MOVIE_TITLE_MAX + 1))).toMatchObject({ ok: false });
    // Padding does not count against the limit.
    expect(parseMovieTitle(`  ${"a".repeat(MOVIE_TITLE_MAX)}  `)).toMatchObject({ ok: true });
  });

  it.each([
    "Amélie",
    "WALL·E",
    "千と千尋の神隠し",
    "기생충",
    "दंगल",
    "Se7en",
    "(500) Days of Summer",
    "9",
    "🚀",
  ])("accepts %s unchanged", (title) => {
    expect(parseMovieTitle(title)).toEqual({ ok: true, title });
  });

  // A title nobody can see is not a title. Zero-width characters are not
  // whitespace to JavaScript, so trimming alone lets these through.
  it.each([
    ["zero-width spaces", "​​​"],
    ["a byte-order mark", "﻿"],
    ["a word joiner", "⁠"],
    ["zero-width characters between spaces", " ​ ‍ "],
    ["control characters", "\u0000\u0001\u001F"],
  ])("rejects a title made only of %s", (_label, input) => {
    expect(parseMovieTitle(input)).toEqual(EMPTY);
  });

  // Postgres cannot store a NUL byte in text at all, so one inside a title
  // would turn a form submit into a server error. Control characters have no
  // place in a title, so they are dropped rather than stored.
  it("drops control characters from inside a title", () => {
    expect(parseMovieTitle("Al\u0000ien")).toEqual({ ok: true, title: "Alien" });
    expect(parseMovieTitle("\u0007The Matrix\u001B")).toEqual({ ok: true, title: "The Matrix" });
  });

  it("keeps markup-looking text as plain text for the UI to escape", () => {
    const title = "<img src=x onerror=alert(1)>";
    expect(parseMovieTitle(title)).toEqual({ ok: true, title });
  });
});

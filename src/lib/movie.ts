import { z } from "zod";
import { toSingleLine } from "./text";

// No server-only imports: the onboarding form reads these constants too.
export const MOVIE_TITLE_MIN = 1;
export const MOVIE_TITLE_MAX = 100;

const EMPTY_MESSAGE = "Please enter a movie title.";

// At least one letter, digit, punctuation mark or symbol (emoji are symbols).
// Zero-width characters are not whitespace, so without this a title nobody
// can see would pass the length check.
const HAS_SOMETHING_VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;

const movieTitle = z
  .string()
  // "  The   Matrix " and "The Matrix" are the same title, and control
  // characters never reach the database.
  .transform(toSingleLine)
  .pipe(
    z
      .string()
      .min(MOVIE_TITLE_MIN, EMPTY_MESSAGE)
      .max(MOVIE_TITLE_MAX, `Please keep it to ${MOVIE_TITLE_MAX} characters or fewer.`)
      .regex(HAS_SOMETHING_VISIBLE, EMPTY_MESSAGE),
  );

export type MovieTitleResult = { ok: true; title: string } | { ok: false; error: string };

export function parseMovieTitle(input: unknown): MovieTitleResult {
  const result = movieTitle.safeParse(input);
  if (result.success) return { ok: true, title: result.data };
  // A non-string (e.g. a file upload in the form field) gets the same message
  // as an empty one rather than zod's internal wording.
  const issue = result.error.issues[0];
  const error = !issue || issue.code === "invalid_type" ? EMPTY_MESSAGE : issue.message;
  return { ok: false, error };
}

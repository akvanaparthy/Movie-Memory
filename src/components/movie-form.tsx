"use client";

import { useActionState, useState } from "react";
import { saveFavoriteMovie, type MovieFormState } from "@/lib/actions";
import { MOVIE_TITLE_MAX } from "@/lib/movie";
import { button } from "./room";
import { Screen, titleSize } from "./screen";
import { BRAND_TONE } from "./tone";

const INITIAL_STATE: MovieFormState = { error: null, value: "" };
const PLACEHOLDER = "Type a title";

/**
 * Onboarding: the user types their favorite movie straight onto the screen,
 * set as the title card it is about to become.
 *
 * `maxLength` and `required` are conveniences only. The server action
 * validates the title again and its answer is the one that counts.
 */
export function MovieForm() {
  const [state, formAction, pending] = useActionState(
    saveFavoriteMovie,
    INITIAL_STATE,
  );
  // Controlled so the card can resize as the title grows, and so the text
  // survives a rejected submit.
  const [title, setTitle] = useState("");

  return (
    <form action={formAction}>
      <Screen
        tone={BRAND_TONE}
        subtitle={
          <label htmlFor="movie" className="subtitle">
            What&rsquo;s your favorite movie?
          </label>
        }
      >
        <textarea
          id="movie"
          name="movie"
          className="title-card"
          data-size={titleSize(title || PLACEHOLDER)}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            // A title is one line: Enter saves instead of breaking the line.
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={PLACEHOLDER}
          rows={1}
          maxLength={MOVIE_TITLE_MAX}
          required
          autoFocus
          autoComplete="off"
          spellCheck={false}
          aria-invalid={state.error !== null}
          aria-describedby="movie-help"
        />
      </Screen>

      <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p
          id="movie-help"
          role={state.error ? "alert" : undefined}
          className={state.error ? "text-sm" : "text-sm text-haze"}
        >
          {state.error ?? "Check the spelling. This can't be changed later."}
        </p>

        <div className="flex items-center justify-between gap-5 sm:justify-end">
          <span className="text-sm text-haze tabular-nums">
            {title.length} / {MOVIE_TITLE_MAX}
          </span>
          <button
            type="submit"
            disabled={pending}
            className={`${button.primary} shrink-0`}
          >
            {pending ? "Saving…" : "Save movie"}
          </button>
        </div>
      </div>
    </form>
  );
}

"use client"; // Error boundaries must be Client Components.

import { useEffect } from "react";
import { Room, button } from "@/components/room";
import { Screen, TitleCard } from "@/components/screen";

/**
 * Shown when a page fails to render, for example if the database is
 * unreachable. The real error goes to the console; the user gets a plain
 * explanation and a way to retry.
 */
export default function ErrorPage({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Room>
      <Screen
        tone="petrol"
        subtitle={
          <p className="subtitle">
            This page couldn&rsquo;t load. Nothing was lost.
          </p>
        }
      >
        <TitleCard size="m">Something went wrong</TitleCard>
      </Screen>

      <div className="mt-10 flex justify-center">
        <button type="button" onClick={() => retry()} className={button.primary}>
          Try again
        </button>
      </div>
    </Room>
  );
}

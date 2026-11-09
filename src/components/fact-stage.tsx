"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { FACT_CACHE_WINDOW_MS, type FactSuccess } from "@/lib/facts/contract";
import { fetchFact, type FactResult } from "./fetch-fact";
import { button } from "./room";
import { Screen, TitleCard } from "./screen";
import type { Tone } from "./tone";

export type FactView =
  | { kind: "loading" }
  // `deadline` is when the cache window closes, on the performance.now() clock.
  | { kind: "ready"; data: FactSuccess; deadline: number }
  | { kind: "failed"; message: string };

/**
 * The dashboard's stage: the movie's title card, with the fact as its subtitle.
 *
 * The server owns the 60-second rule. This component only shows it: it asks
 * for a fact on load, counts down the `freshForMs` the server reported, and
 * unlocks "New fact" when that reaches zero. Asking early would be harmless
 * (the server would return the same cached fact), so the lock is there to tell
 * the truth about what a click will do, not to enforce anything.
 */
export function FactStage({
  movie,
  tone,
  children,
}: {
  movie: string;
  tone: Tone;
  /** The signed-in user's profile, rendered on the server. */
  children: ReactNode;
}) {
  const router = useRouter();
  const [view, setView] = useState<FactView>({ kind: "loading" });
  const [remainingMs, setRemainingMs] = useState(0);

  const show = useCallback(
    (result: FactResult) => {
      if (result.ok) {
        setRemainingMs(result.data.freshForMs);
        setView({
          kind: "ready",
          data: result.data,
          deadline: performance.now() + result.data.freshForMs,
        });
      } else if (result.code === "UNAUTHENTICATED") {
        router.replace("/"); // the session ended in another tab
      } else if (result.code === "NO_MOVIE") {
        router.replace("/onboarding");
      } else {
        setView({ kind: "failed", message: result.message });
      }
    },
    [router],
  );

  // First fact on load. Aborting covers unmount and React's dev double-invoke.
  useEffect(() => {
    const controller = new AbortController();
    void fetchFact(controller.signal).then((result) => {
      if (!controller.signal.aborted) show(result);
    });
    return () => controller.abort();
  }, [show]);

  // Count the window down against a fixed deadline, so a throttled background
  // tab catches up when it returns instead of drifting.
  useEffect(() => {
    if (view.kind !== "ready" || view.data.status === "stale") return;

    const timer = setInterval(() => {
      const left = Math.max(0, view.deadline - performance.now());
      setRemainingMs(left);
      if (left === 0) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [view]);

  function refresh() {
    setView({ kind: "loading" });
    void fetchFact().then(show);
  }

  return (
    <FactStageView
      movie={movie}
      tone={tone}
      view={view}
      remainingMs={remainingMs}
      onRefresh={refresh}
    >
      {children}
    </FactStageView>
  );
}

/** Everything the stage draws, as a pure function of its state. */
export function FactStageView({
  movie,
  tone,
  view,
  remainingMs,
  onRefresh,
  children,
}: {
  movie: string;
  tone: Tone;
  view: FactView;
  remainingMs: number;
  onRefresh: () => void;
  children: ReactNode;
}) {
  const data = view.kind === "ready" ? view.data : null;
  const isStale = data?.status === "stale";
  const isCounting = data !== null && !isStale && remainingMs > 0;

  let status = "";
  if (isStale) status = "Couldn't get a new fact, so this is an earlier one.";
  else if (isCounting) status = `Next fact in ${formatClock(remainingMs)}`;
  else if (data) status = "A new fact is ready.";

  const canRefresh = view.kind === "failed" || (data !== null && !isCounting);
  const action = view.kind === "failed" || isStale ? "Try again" : "New fact";

  return (
    <>
      <Screen
        tone={tone}
        subtitle={
          <div aria-live="polite" className="grid justify-items-center">
            {view.kind === "loading" && (
              <p className="subtitle text-haze italic motion-safe:animate-pulse">
                Finding a fact&hellip;
              </p>
            )}
            {view.kind === "ready" && (
              <p key={view.data.fact.id} className="subtitle cue">
                {view.data.fact.text}
              </p>
            )}
            {view.kind === "failed" && (
              <p className="subtitle cue">{view.message}</p>
            )}
          </div>
        }
        reel={<Reel data={isStale ? null : data} />}
      >
        <TitleCard>{movie}</TitleCard>
      </Screen>

      <div className="mt-8 flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
        {children}

        <div className="flex items-center justify-between gap-5 sm:justify-end">
          <p id="fact-status" className="text-sm text-haze tabular-nums">
            {status}
          </p>
          <button
            type="button"
            onClick={onRefresh}
            disabled={!canRefresh}
            aria-describedby="fact-status"
            className={`${button.primary} shrink-0`}
          >
            {action}
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * The line along the bottom of the screen. It starts as far along as the fact
 * is old and runs to the end as the cache window closes. CSS does the
 * animation; the key restarts it whenever a new response arrives.
 */
function Reel({ data }: { data: FactSuccess | null }) {
  return (
    <div className="reel" aria-hidden="true">
      {data && (
        <div
          key={`${data.fact.id}:${data.freshForMs}`}
          className="reel-fill"
          style={
            {
              "--reel-from": 1 - data.freshForMs / FACT_CACHE_WINDOW_MS,
              "--reel-remaining": `${data.freshForMs}ms`,
            } as CSSProperties
          }
        />
      )}
    </div>
  );
}

/** 42_300 -> "0:43". Rounds up so the clock never reads 0:00 while time is left. */
function formatClock(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

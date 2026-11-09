import type { ReactNode } from "react";

/**
 * The dark room every page sits in: a quiet top bar, then the stage centred in
 * what is left of the viewport.
 *
 * The outer element clips overflow so the screen's glow, which is drawn well
 * outside the screen, never adds a scrollbar.
 */
export function Room({
  bar,
  children,
}: {
  bar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-svh overflow-clip">
      <div className="room mx-auto grid min-h-svh w-full grid-rows-[auto_1fr] px-4 sm:px-8">
        <header className="flex h-16 items-center justify-between gap-4">
          {bar}
        </header>
        <main className="flex flex-col justify-center pb-16">{children}</main>
      </div>
    </div>
  );
}

/** The product name, set like a small title card. */
export function Wordmark() {
  return (
    <span className="text-xs tracking-[0.16em] text-haze uppercase [font-stretch:125%]">
      Movie Memory
    </span>
  );
}

/** Shared button shapes, so every page presses the same way. */
export const button = {
  primary:
    "inline-flex h-11 cursor-pointer items-center justify-center gap-2.5 rounded-full bg-light px-5 text-[0.9375rem] font-medium text-black transition-[transform,opacity] duration-150 active:scale-[0.97] disabled:cursor-not-allowed disabled:bg-transparent disabled:text-haze disabled:inset-ring disabled:inset-ring-dust",
  quiet:
    "cursor-pointer rounded-full text-sm text-haze transition-colors duration-150 hover:text-light",
} as const;

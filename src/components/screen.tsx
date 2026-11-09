import type { ReactNode } from "react";
import type { Tone } from "./tone";

/**
 * The lit screen. It is the same object on every page and only the card on it
 * changes, which is what makes three pages feel like one room.
 *
 * - `children`: the title card.
 * - `subtitle`: the lower third, where film subtitles sit.
 * - `reel`:     the progress line along the bottom edge.
 */
export function Screen({
  tone,
  children,
  subtitle,
  reel,
}: {
  tone: Tone;
  children: ReactNode;
  subtitle?: ReactNode;
  reel?: ReactNode;
}) {
  return (
    <div className="stage" data-tone={tone}>
      <div className="screen">
        <div className="screen-safe">
          <div className="screen-title">{children}</div>
          <div className="screen-subtitle">{subtitle}</div>
        </div>
        {reel}
      </div>
    </div>
  );
}

export type TitleSize = "s" | "m" | "l" | "xl";

/**
 * Longer titles are set smaller. The thresholds are character counts, tuned so
 * a title of any allowed length fits the card at every screen width.
 */
export function titleSize(text: string): TitleSize {
  const length = text.trim().length;
  if (length <= 10) return "s";
  if (length <= 22) return "m";
  if (length <= 48) return "l";
  return "xl";
}

export function TitleCard({
  children,
  size,
}: {
  children: string;
  /** Override for fixed copy; user-entered titles should leave this unset. */
  size?: TitleSize;
}) {
  return (
    <h1 className="title-card" data-size={size ?? titleSize(children)}>
      {children}
    </h1>
  );
}

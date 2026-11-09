/** The fields a title card can be lit in. Colours live in globals.css. */
export const TONES = [
  "ultramarine",
  "crimson",
  "emerald",
  "aubergine",
  "rust",
  "petrol",
] as const;

export type Tone = (typeof TONES)[number];

/** The product's own card: the landing page and onboarding. */
export const BRAND_TONE: Tone = "ultramarine";

/**
 * Picks the tone for a movie's title card. Purely cosmetic: a small stable
 * hash, so the same title is always lit the same colour.
 */
export function toneFor(title: string): Tone {
  let hash = 0;
  for (const char of title.trim().toLowerCase()) {
    hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  }
  return TONES[hash % TONES.length];
}

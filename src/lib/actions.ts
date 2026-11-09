"use server";

import { redirect } from "next/navigation";
import { signIn, signOut } from "@/auth";
import { getDb } from "@/lib/db";
import { parseMovieTitle } from "@/lib/movie";
import { getCurrentUser } from "@/lib/session";

export type MovieFormState = { error: string | null; value: string };

/**
 * Onboarding. Server actions are public endpoints, so this re-reads the
 * session and re-validates the input itself instead of trusting the form.
 */
export async function saveFavoriteMovie(
  _prev: MovieFormState,
  formData: FormData,
): Promise<MovieFormState> {
  const user = await getCurrentUser();
  if (!user) redirect("/");

  const raw = formData.get("movie");
  const value = typeof raw === "string" ? raw : "";
  const parsed = parseMovieTitle(raw);
  if (!parsed.ok) return { error: parsed.error, value };

  // Onboarding is first-time only: the `favoriteMovie: null` condition makes
  // a replayed or double-submitted form a no-op instead of an overwrite.
  await getDb().user.updateMany({
    where: { id: user.id, favoriteMovie: null },
    data: { favoriteMovie: parsed.title },
  });

  redirect("/dashboard");
}

export async function signInWithGoogle(): Promise<void> {
  await signIn("google", { redirectTo: "/dashboard" });
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/" });
}

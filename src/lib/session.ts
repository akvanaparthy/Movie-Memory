import "server-only";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { auth } from "@/auth";
import { getDb } from "@/lib/db";

/** The only user shape the UI sees: never the raw session or account rows. */
export type CurrentUser = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  favoriteMovie: string | null;
};

/** The signed-in user, or null when signed out. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  // Auth.js draws random bytes before it reads the request. With Cache
  // Components, Next.js treats that as an attempt to prerender something
  // random and reports an error, so say first that this is per-request work.
  await connection();

  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;

  // Read from the database rather than the session object so favoriteMovie
  // is always current (it changes during onboarding).
  return getDb().user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, image: true, favoriteMovie: true },
  });
}

/** The signed-in user; signed-out visitors are redirected to the home page. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/");
  return user;
}

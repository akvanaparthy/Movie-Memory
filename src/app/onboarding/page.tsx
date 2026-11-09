import { redirect } from "next/navigation";
import { SignOutButton } from "@/components/auth-buttons";
import { MovieForm } from "@/components/movie-form";
import { Room, Wordmark } from "@/components/room";
import { requireUser } from "@/lib/session";

// Session-gated: render per request so the redirects below are real HTTP ones.
export const instant = false;

export default async function OnboardingPage() {
  const user = await requireUser(); // signed out -> "/"

  // Onboarding is first-time only. Anyone who already has a movie moves on.
  if (user.favoriteMovie) {
    redirect("/dashboard");
  }

  return (
    <Room
      bar={
        <>
          <Wordmark />
          <SignOutButton />
        </>
      }
    >
      <MovieForm />
    </Room>
  );
}

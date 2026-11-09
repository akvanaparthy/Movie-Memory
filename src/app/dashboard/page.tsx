import { redirect } from "next/navigation";
import { SignOutButton } from "@/components/auth-buttons";
import { FactStage } from "@/components/fact-stage";
import { Profile } from "@/components/profile";
import { Room, Wordmark } from "@/components/room";
import { toneFor } from "@/components/tone";
import { requireUser } from "@/lib/session";

// Session-gated: render per request so the redirects below are real HTTP ones.
export const instant = false;

export default async function DashboardPage() {
  const user = await requireUser(); // signed out -> "/"

  if (!user.favoriteMovie) {
    redirect("/onboarding");
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
      <FactStage movie={user.favoriteMovie} tone={toneFor(user.favoriteMovie)}>
        {/* Pass only what the profile shows; the user id stays on the server. */}
        <Profile
          user={{ name: user.name, email: user.email, image: user.image }}
        />
      </FactStage>
    </Room>
  );
}

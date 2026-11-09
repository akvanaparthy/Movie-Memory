import { redirect } from "next/navigation";
import { SignInButton } from "@/components/auth-buttons";
import { Room } from "@/components/room";
import { Screen, TitleCard } from "@/components/screen";
import { BRAND_TONE } from "@/components/tone";
import { getCurrentUser } from "@/lib/session";

// This page depends on the session, so it renders per request. Blocking here
// (rather than streaming behind a Suspense boundary) means a signed-in visitor
// gets a real HTTP redirect before any HTML is sent.
export const instant = false;

export default async function LandingPage() {
  const user = await getCurrentUser();
  if (user) {
    redirect(user.favoriteMovie ? "/dashboard" : "/onboarding");
  }

  return (
    <Room>
      <Screen
        tone={BRAND_TONE}
        subtitle={
          <p className="subtitle cue [animation-delay:1000ms]">
            Tell us your favorite movie and get a new fact about it every
            minute.
          </p>
        }
      >
        <TitleCard size="s">Movie Memory</TitleCard>
      </Screen>

      <div className="mt-10 flex flex-col items-center gap-4">
        <SignInButton />
        <p className="text-sm text-haze">
          We only read your Google name, email and photo.
        </p>
      </div>
    </Room>
  );
}

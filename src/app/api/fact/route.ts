import { auth } from "@/auth";
import { getDb } from "@/lib/db";
import type { FactError, FactErrorCode } from "@/lib/facts/contract";
import { generateFactWithOpenAI } from "@/lib/facts/generate";
import { getFact } from "@/lib/facts/service";

// Identity comes from the session cookie and nothing else. The request is not
// even read, so a `?userId=` or a body cannot select another user's facts.
export async function GET(): Promise<Response> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return error(401, "UNAUTHENTICATED", "Please sign in to see your movie fact.");

  try {
    const outcome = await getFact(userId, {
      db: getDb(),
      now: () => new Date(),
      generate: generateFactWithOpenAI,
    });

    switch (outcome.type) {
      case "success":
        return json(200, outcome.body);
      case "no_movie":
        return error(409, "NO_MOVIE", "Pick your favorite movie first.");
      case "generation_failed":
        return error(503, "GENERATION_FAILED", GENERATION_FAILED_MESSAGE);
    }
  } catch (err) {
    // Unexpected (e.g. the database is down). Log the real error here; the
    // client only gets the generic message.
    console.error("GET /api/fact failed", err);
    return error(503, "GENERATION_FAILED", GENERATION_FAILED_MESSAGE);
  }
}

const GENERATION_FAILED_MESSAGE = "We couldn't come up with a fact right now. Please try again in a moment.";

function error(status: number, code: FactErrorCode, message: string): Response {
  const body: FactError = { error: { code, message } };
  return json(status, body);
}

function json(status: number, body: unknown): Response {
  // Per-user and time-sensitive: no browser or CDN may cache it.
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

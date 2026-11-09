import type {
  FactError,
  FactErrorCode,
  FactSuccess,
} from "@/lib/facts/contract";

export type FactResult =
  | { ok: true; data: FactSuccess }
  | { ok: false; code: FactErrorCode | "NETWORK"; message: string };

const NETWORK_MESSAGE =
  "Couldn't reach the server. Check your connection and try again.";

/**
 * Calls `GET /api/fact` and folds every outcome into one result type, so the
 * UI never handles a thrown error or an unexpected response shape.
 */
export async function fetchFact(signal?: AbortSignal): Promise<FactResult> {
  try {
    const response = await fetch("/api/fact", {
      signal,
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    const body = (await response.json()) as FactSuccess | FactError;

    if (response.ok && "fact" in body) {
      return { ok: true, data: body };
    }
    if ("error" in body) {
      return { ok: false, ...body.error };
    }
    return { ok: false, code: "NETWORK", message: NETWORK_MESSAGE };
  } catch {
    // Offline, aborted, or a non-JSON response (for example a proxy error page).
    return { ok: false, code: "NETWORK", message: NETWORK_MESSAGE };
  }
}

/**
 * Every timing the fact service depends on, in one place, because they only
 * make sense relative to each other.
 *
 * Invariant: LEASE_TTL_MS > OPENAI_TIMEOUT_MS (and OpenAI retries are off, so
 * the timeout bounds the whole call). A healthy lease holder therefore always
 * finishes, or gives up, before its lease can expire, so no second request can
 * take the lease over and call OpenAI in parallel. The TTL exists only so that
 * a process that crashes mid-generation cannot block that user forever.
 *
 * Waiters give up a little after the holder's worst case, so in the normal
 * failure case they see the lease released and fall back right away; the
 * deadline only matters if the holder died without releasing.
 *
 * After a failed generation, the user gets no new OpenAI call for
 * FAILURE_COOLDOWN_MS: while OpenAI is down, each request would otherwise wait
 * up to the full timeout for a call that fails anyway, before falling back.
 * It is short because the UI shows no countdown for it, so it should not leave
 * "Try again" feeling dead for long.
 */
export const OPENAI_TIMEOUT_MS = 10_000;
export const LEASE_TTL_MS = 30_000;
export const WAIT_DEADLINE_MS = 12_000;
export const POLL_INTERVAL_MS = 250;
export const FAILURE_COOLDOWN_MS = 15_000;

export type FactTimings = {
  leaseTtlMs: number;
  waitDeadlineMs: number;
  pollIntervalMs: number;
  failureCooldownMs: number;
};

export const DEFAULT_TIMINGS: FactTimings = {
  leaseTtlMs: LEASE_TTL_MS,
  waitDeadlineMs: WAIT_DEADLINE_MS,
  pollIntervalMs: POLL_INTERVAL_MS,
  failureCooldownMs: FAILURE_COOLDOWN_MS,
};

import { afterAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { createDb } from "@/lib/db";
import { FACT_CACHE_WINDOW_MS } from "@/lib/facts/contract";
import type { FactGenerator, GeneratedFact } from "@/lib/facts/generate";
import {
  getFact,
  PREVIOUS_FACTS_LIMIT,
  type FactDeps,
  type FactOutcome,
} from "@/lib/facts/service";

// Real Postgres (see global-setup.ts), fake clock, fake generator.
const db = createDb(inject("databaseUrl"));
afterAll(() => db.$disconnect());

const T0 = new Date("2026-01-01T12:00:00.000Z").getTime();
const COOLDOWN_MS = 15_000;
let nowMs = T0;

beforeEach(async () => {
  nowMs = T0;
  await db.$executeRaw`TRUNCATE "User" CASCADE`;
});

function deps(generate: FactGenerator): FactDeps {
  return {
    db,
    now: () => new Date(nowMs),
    generate,
    // Short polls keep the tests fast. The clock is frozen, so waiters stop
    // because the lease is released, not because of the deadline.
    timings: {
      leaseTtlMs: 30_000,
      waitDeadlineMs: 12_000,
      pollIntervalMs: 5,
      failureCooldownMs: COOLDOWN_MS,
    },
  };
}

/**
 * Deps for a request that has to wait on someone else's lease. Polls use the
 * production interval and each one moves the fake clock forward, so the
 * waiter's deadline and the lease's expiry are reached for real.
 */
function waitingDeps(generate: FactGenerator): FactDeps {
  const base = deps(generate);
  return {
    ...base,
    timings: { ...base.timings!, pollIntervalMs: 250 },
    sleep: async (ms) => {
      nowMs += ms;
    },
  };
}

/** A promise the test resolves by hand, to hold a generator mid-call. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The distinct things a batch of requests received. */
function textsOf(outcomes: FactOutcome[]) {
  return new Set(outcomes.map((o) => (o.type === "success" ? o.body.fact.text : o.type)));
}

function fakeGenerator(text = "A fresh fact.") {
  return vi.fn<FactGenerator>(async () => ({ text, model: "fake-model" }));
}

function failingGenerator() {
  return vi.fn<FactGenerator>(async () => {
    throw new Error("OpenAI is down");
  });
}

async function createUser(email: string, favoriteMovie: string | null = "Alien") {
  return db.user.create({ data: { email, favoriteMovie } });
}

async function createFact(userId: string, ageMs: number, text = "An older fact.", movie = "Alien") {
  return db.fact.create({
    data: { userId, movie, text, model: "fake-model", createdAt: new Date(nowMs - ageMs) },
  });
}

describe("getFact", () => {
  it("reports a user without a favorite movie", async () => {
    const user = await createUser("a@example.com", null);
    const generate = fakeGenerator();
    expect(await getFact(user.id, deps(generate))).toEqual({ type: "no_movie" });
    expect(generate).not.toHaveBeenCalled();
  });

  describe("cache window", () => {
    it("serves a 59 999 ms old fact as cached without generating", async () => {
      const user = await createUser("a@example.com");
      const fact = await createFact(user.id, FACT_CACHE_WINDOW_MS - 1);
      const generate = fakeGenerator();

      const outcome = await getFact(user.id, deps(generate));

      expect(generate).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({
        type: "success",
        body: { status: "cached", freshForMs: 1, fact: { id: fact.id } },
      });
    });

    it("generates a new fact once the old one is exactly 60 000 ms old", async () => {
      const user = await createUser("a@example.com");
      await createFact(user.id, FACT_CACHE_WINDOW_MS);
      const generate = fakeGenerator("Brand new.");

      const outcome = await getFact(user.id, deps(generate));

      expect(generate).toHaveBeenCalledOnce();
      expect(generate).toHaveBeenCalledWith("Alien", ["An older fact."]);
      expect(outcome).toMatchObject({
        type: "success",
        body: { status: "fresh", freshForMs: FACT_CACHE_WINDOW_MS, fact: { text: "Brand new." } },
      });
    });
  });

  describe("burst", () => {
    it("makes exactly one generator call for 10 concurrent requests", async () => {
      const user = await createUser("a@example.com");
      // Slow enough that every request arrives while generation is in flight.
      const generate = vi.fn<FactGenerator>(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { text: "The one fact.", model: "fake-model" };
      });

      const outcomes = await Promise.all(
        Array.from({ length: 10 }, () => getFact(user.id, deps(generate))),
      );

      expect(generate).toHaveBeenCalledOnce();
      const ids = outcomes.map((o) => (o.type === "success" ? o.body.fact.id : o.type));
      expect(new Set(ids).size).toBe(1);
      const statuses = outcomes.map((o) => (o.type === "success" ? o.body.status : o.type)).sort();
      expect(statuses).toEqual([...Array(9).fill("cached"), "fresh"]);
      expect(await db.fact.count()).toBe(1);
    });

    it("still makes one call when that call fails", async () => {
      const user = await createUser("a@example.com");
      const generate = vi.fn<FactGenerator>(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        throw new Error("OpenAI is down");
      });

      const outcomes = await Promise.all(
        Array.from({ length: 10 }, () => getFact(user.id, deps(generate))),
      );

      expect(generate).toHaveBeenCalledOnce();
      expect(outcomes.every((o) => o.type === "generation_failed")).toBe(true);
    });
  });

  describe("failure", () => {
    it("serves the most recent older fact as stale", async () => {
      const user = await createUser("a@example.com");
      await createFact(user.id, 10 * 60_000, "Oldest.");
      const newest = await createFact(user.id, 5 * 60_000, "Newer.");

      const outcome = await getFact(user.id, deps(failingGenerator()));

      expect(outcome).toMatchObject({
        type: "success",
        body: { status: "stale", freshForMs: 0, fact: { id: newest.id, text: "Newer." } },
      });
      expect(await db.factLease.count()).toBe(0);
    });

    it("reports generation_failed when there is no earlier fact", async () => {
      const user = await createUser("a@example.com");

      expect(await getFact(user.id, deps(failingGenerator()))).toEqual({
        type: "generation_failed",
      });
      expect(await db.factLease.count()).toBe(0);
    });

    it("takes over a lease left behind by a crashed holder once it expires", async () => {
      const user = await createUser("a@example.com");
      await db.factLease.create({
        data: { userId: user.id, token: "crashed", expiresAt: new Date(nowMs - 1) },
      });
      const generate = fakeGenerator();

      const outcome = await getFact(user.id, deps(generate));

      expect(generate).toHaveBeenCalledOnce();
      expect(outcome).toMatchObject({ type: "success", body: { status: "fresh" } });
      expect(await db.factLease.count()).toBe(0);
    });
  });

  describe("failure cooldown", () => {
    it("serves the older fact without calling OpenAI again inside the cooldown", async () => {
      const user = await createUser("a@example.com");
      const older = await createFact(user.id, 5 * 60_000);
      const generate = failingGenerator();

      await getFact(user.id, deps(generate));
      nowMs += COOLDOWN_MS - 1;
      const outcome = await getFact(user.id, deps(generate));

      expect(generate).toHaveBeenCalledOnce();
      expect(outcome).toMatchObject({
        type: "success",
        body: { status: "stale", freshForMs: 0, fact: { id: older.id } },
      });
      expect(await db.factLease.count()).toBe(0);
    });

    it("reports generation_failed inside the cooldown when there is no older fact", async () => {
      const user = await createUser("a@example.com");
      const generate = failingGenerator();

      await getFact(user.id, deps(generate));
      const outcome = await getFact(user.id, deps(generate));

      expect(generate).toHaveBeenCalledOnce();
      expect(outcome).toEqual({ type: "generation_failed" });
    });

    it("calls OpenAI again once the cooldown has passed", async () => {
      const user = await createUser("a@example.com");
      const generate = vi
        .fn<FactGenerator>()
        .mockRejectedValueOnce(new Error("OpenAI is down"))
        .mockResolvedValue({ text: "Back up.", model: "fake-model" });

      await getFact(user.id, deps(generate));
      nowMs += COOLDOWN_MS;
      const outcome = await getFact(user.id, deps(generate));

      expect(generate).toHaveBeenCalledTimes(2);
      expect(outcome).toMatchObject({
        type: "success",
        body: { status: "fresh", fact: { text: "Back up." } },
      });
    });
  });

  describe("previous facts", () => {
    it("passes this user's earlier facts for this movie, newest first", async () => {
      const alice = await createUser("alice@example.com", "Alien");
      const bob = await createUser("bob@example.com", "Alien");
      await createFact(alice.id, 3 * 60_000, "Alice, oldest.");
      await createFact(alice.id, 2 * 60_000, "Alice, newest.");
      await createFact(alice.id, 1 * 60_000, "Alice, another movie.", "Aliens");
      await createFact(bob.id, 1 * 60_000, "Bob's fact.");
      const generate = fakeGenerator();

      await getFact(alice.id, deps(generate));

      expect(generate).toHaveBeenCalledWith("Alien", ["Alice, newest.", "Alice, oldest."]);
    });

    it(`passes at most ${PREVIOUS_FACTS_LIMIT} earlier facts`, async () => {
      const user = await createUser("a@example.com");
      for (let i = 1; i <= PREVIOUS_FACTS_LIMIT + 2; i++) {
        await createFact(user.id, i * 60_000, `Fact ${i}.`);
      }
      const generate = fakeGenerator();

      await getFact(user.id, deps(generate));

      const expected = Array.from({ length: PREVIOUS_FACTS_LIMIT }, (_, i) => `Fact ${i + 1}.`);
      expect(generate).toHaveBeenCalledWith("Alien", expected);
    });
  });

  describe("authorization", () => {
    it("never serves one user's fact to another, even for the same movie", async () => {
      const alice = await createUser("alice@example.com", "Alien");
      const bob = await createUser("bob@example.com", "Alien");
      const alicesFact = await createFact(alice.id, 1_000, "Alice's fact.");
      const generate = fakeGenerator("Bob's fact.");

      const outcome = await getFact(bob.id, deps(generate));

      expect(generate).toHaveBeenCalledOnce();
      expect(outcome.type).toBe("success");
      if (outcome.type !== "success") return;
      expect(outcome.body.fact.id).not.toBe(alicesFact.id);
      expect(outcome.body.fact.text).toBe("Bob's fact.");
    });

    it("does not serve a stale fact from another user when generation fails", async () => {
      const alice = await createUser("alice@example.com", "Alien");
      const bob = await createUser("bob@example.com", "Alien");
      await createFact(alice.id, 5 * 60_000, "Alice's fact.");

      expect(await getFact(bob.id, deps(failingGenerator()))).toEqual({
        type: "generation_failed",
      });
    });

    it("gives two users bursting at the same time one generation each", async () => {
      const alice = await createUser("alice@example.com", "Alien");
      const bob = await createUser("bob@example.com", "Blade Runner");
      const generate = vi.fn<FactGenerator>(async (movie) => {
        await pause(150);
        return { text: `About ${movie}.`, model: "fake-model" };
      });

      const [forAlice, forBob] = await Promise.all([
        Promise.all(Array.from({ length: 10 }, () => getFact(alice.id, deps(generate)))),
        Promise.all(Array.from({ length: 10 }, () => getFact(bob.id, deps(generate)))),
      ]);

      expect(generate).toHaveBeenCalledTimes(2);
      expect(textsOf(forAlice)).toEqual(new Set(["About Alien."]));
      expect(textsOf(forBob)).toEqual(new Set(["About Blade Runner."]));
      expect(await db.fact.count()).toBe(2);
    });

    it("does not let one user's cooldown hold back another user", async () => {
      const alice = await createUser("alice@example.com", "Alien");
      const bob = await createUser("bob@example.com", "Alien");
      await getFact(alice.id, deps(failingGenerator())); // starts Alice's cooldown
      const generate = fakeGenerator("Bob's fact.");

      const outcome = await getFact(bob.id, deps(generate));

      expect(generate).toHaveBeenCalledOnce();
      expect(outcome).toMatchObject({ type: "success", body: { status: "fresh" } });
    });
  });

  describe("cache key", () => {
    it("does not serve a fresh fact that belongs to a different movie", async () => {
      const user = await createUser("a@example.com", "Alien");
      await createFact(user.id, 1_000, "About the sequel.", "Aliens");
      const generate = fakeGenerator("About Alien.");

      const outcome = await getFact(user.id, deps(generate));

      expect(generate).toHaveBeenCalledOnce();
      expect(outcome).toMatchObject({
        type: "success",
        body: { status: "fresh", fact: { movie: "Alien", text: "About Alien." } },
      });
    });
  });

  describe("waiting requests", () => {
    it("give up at the deadline when the holder never finishes, without generating", async () => {
      const user = await createUser("a@example.com");
      const older = await createFact(user.id, 5 * 60_000);
      // Another request holds a live lease and is hung.
      await db.factLease.create({
        data: { userId: user.id, token: "hung", expiresAt: new Date(nowMs + 30_000) },
      });
      const generate = fakeGenerator();

      const outcome = await getFact(user.id, waitingDeps(generate));

      expect(generate).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({
        type: "success",
        body: { status: "stale", fact: { id: older.id } },
      });
      expect(nowMs - T0).toBe(12_000); // waited the deadline and no longer
      // The waiter left the other request's lease alone.
      expect(await db.factLease.findUnique({ where: { userId: user.id } })).toMatchObject({
        token: "hung",
      });
    });

    it("stop as soon as the holder's lease runs out, and leave generating to the next request", async () => {
      const user = await createUser("a@example.com");
      // The holder crashed: its lease has one second left and nobody will release it.
      await db.factLease.create({
        data: { userId: user.id, token: "crashed", expiresAt: new Date(nowMs + 1_000) },
      });
      const generate = fakeGenerator();

      const waited = await getFact(user.id, waitingDeps(generate));

      expect(generate).not.toHaveBeenCalled();
      expect(waited).toEqual({ type: "generation_failed" });
      expect(nowMs - T0).toBe(1_000);

      // A waiter giving up is not an OpenAI failure, so there is no cooldown:
      // the very next request takes the expired lease over and generates.
      const next = await getFact(user.id, deps(generate));

      expect(generate).toHaveBeenCalledOnce();
      expect(next).toMatchObject({ type: "success", body: { status: "fresh" } });
    });
  });

  describe("lease ownership", () => {
    it("a holder that overran its lease does not release the lease of the request that took over", async () => {
      const user = await createUser("a@example.com");
      const first = deferred<GeneratedFact>();
      const second = deferred<GeneratedFact>();
      const generate = vi
        .fn<FactGenerator>()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);

      // Request 1 takes the lease and hangs inside the generator.
      const slow = getFact(user.id, deps(generate));
      await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));

      // Its lease expires, and request 2 takes it over.
      nowMs += 30_000;
      const takeover = getFact(user.id, deps(generate));
      await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));

      // Request 1 finally finishes. It must not delete request 2's lease.
      first.resolve({ text: "Late.", model: "fake-model" });
      await slow;
      expect(await db.factLease.findUnique({ where: { userId: user.id } })).toMatchObject({
        expiresAt: new Date(T0 + 60_000),
      });

      second.resolve({ text: "Second.", model: "fake-model" });
      await takeover;
      expect(await db.factLease.count()).toBe(0);
    });

    it("releases the lease when storing the fact fails", async () => {
      const user = await createUser("a@example.com");
      // Postgres refuses a NUL byte in text, so this insert fails for real.
      const generate = fakeGenerator("bad\u0000text");

      await expect(getFact(user.id, deps(generate))).rejects.toThrow();

      expect(await db.fact.count()).toBe(0);
      expect(await db.factLease.count()).toBe(0);
    });
  });

  describe("under load", () => {
    it(
      "costs one generation per window for 50 concurrent requests, five windows in a row",
      { timeout: 60_000 },
      async () => {
        const user = await createUser("a@example.com");
        let made = 0;
        const generate = vi.fn<FactGenerator>(async () => {
          await pause(50);
          return { text: `Fact ${++made}.`, model: "fake-model" };
        });

        for (let window = 1; window <= 5; window++) {
          const outcomes = await Promise.all(
            Array.from({ length: 50 }, () => getFact(user.id, deps(generate))),
          );

          expect(generate).toHaveBeenCalledTimes(window);
          expect(textsOf(outcomes)).toEqual(new Set([`Fact ${window}.`]));
          nowMs += FACT_CACHE_WINDOW_MS; // the window closes
        }

        expect(await db.fact.count()).toBe(5);
        expect(await db.factLease.count()).toBe(0);
      },
    );
  });
});

import { afterAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { createDb } from "@/lib/db";
import { FACT_CACHE_WINDOW_MS } from "@/lib/facts/contract";
import type { FactGenerator } from "@/lib/facts/generate";
import { getFact, PREVIOUS_FACTS_LIMIT, type FactDeps } from "@/lib/facts/service";

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
  });
});

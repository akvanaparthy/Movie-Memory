import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// saveFavoriteMovie runs for real against Postgres. Only its three edges are
// replaced: who is signed in, the redirect (which throws, as it does in
// Next.js), and the Auth.js module the file also imports.
const { getCurrentUser, Redirect } = vi.hoisted(() => {
  class Redirect extends Error {
    constructor(readonly url: string) {
      super(`redirect to ${url}`);
    }
  }
  return { getCurrentUser: vi.fn(), Redirect };
});

vi.mock("@/lib/session", () => ({ getCurrentUser }));
vi.mock("@/auth", () => ({ signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { inject } = await import("vitest");
  const db = actual.createDb(inject("databaseUrl"));
  return { ...actual, getDb: () => db };
});

const { getDb } = await import("@/lib/db");
const { saveFavoriteMovie } = await import("@/lib/actions");

const db = getDb();
afterAll(() => db.$disconnect());

beforeEach(async () => {
  getCurrentUser.mockReset();
  await db.$executeRaw`TRUNCATE "User" CASCADE`;
});

async function createUser(email: string, favoriteMovie: string | null = null) {
  return db.user.create({ data: { email, favoriteMovie } });
}

function signInAs(user: { id: string; email: string; favoriteMovie: string | null }) {
  getCurrentUser.mockResolvedValue({ ...user, name: null, image: null });
}

/** Submits the form and reports where it redirected, or what it returned. */
async function submit(fields: Record<string, string | Blob>) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  try {
    return { state: await saveFavoriteMovie({ error: null, value: "" }, form) };
  } catch (error) {
    if (error instanceof Redirect) return { redirectedTo: error.url };
    throw error;
  }
}

const movieOf = async (id: string) =>
  (await db.user.findUniqueOrThrow({ where: { id } })).favoriteMovie;

describe("saveFavoriteMovie", () => {
  it("saves the cleaned title for the signed-in user and goes to the dashboard", async () => {
    const user = await createUser("a@example.com");
    signInAs(user);

    const result = await submit({ movie: "  The   Matrix " });

    expect(result).toEqual({ redirectedTo: "/dashboard" });
    expect(await movieOf(user.id)).toBe("The Matrix");
  });

  it("sends a signed-out caller home without writing anything", async () => {
    const bystander = await createUser("a@example.com");
    getCurrentUser.mockResolvedValue(null);

    const result = await submit({ movie: "Alien" });

    expect(result).toEqual({ redirectedTo: "/" });
    expect(await movieOf(bystander.id)).toBeNull();
  });

  it.each([
    ["an empty title", { movie: "" }, ""],
    ["a whitespace-only title", { movie: "   " }, "   "],
    ["a title that is too long", { movie: "a".repeat(101) }, "a".repeat(101)],
    ["a missing field", {}, ""],
    ["a file in place of text", { movie: new File(["Alien"], "movie.txt") }, ""],
  ])("rejects %s, keeps the input for the form, and writes nothing", async (_label, fields, value) => {
    const user = await createUser("a@example.com");
    signInAs(user);

    const result = await submit(fields);

    expect(result.state).toMatchObject({ value });
    expect(result.state?.error).toEqual(expect.any(String));
    expect(await movieOf(user.id)).toBeNull();
  });

  it("does not overwrite a movie that is already saved (replayed or forged submit)", async () => {
    const user = await createUser("a@example.com", "Alien");
    signInAs(user);

    const result = await submit({ movie: "Something Else" });

    expect(result).toEqual({ redirectedTo: "/dashboard" });
    expect(await movieOf(user.id)).toBe("Alien");
  });

  it("writes only to the session's user, whatever ids the form carries", async () => {
    const alice = await createUser("alice@example.com");
    const bob = await createUser("bob@example.com");
    signInAs(alice);

    await submit({ movie: "Alien", userId: bob.id, id: bob.id, email: bob.email });

    expect(await movieOf(alice.id)).toBe("Alien");
    expect(await movieOf(bob.id)).toBeNull();
  });

  it("lets exactly one of two simultaneous submits win", async () => {
    const user = await createUser("a@example.com");
    signInAs(user);

    const results = await Promise.all([submit({ movie: "First" }), submit({ movie: "Second" })]);

    expect(results).toEqual([{ redirectedTo: "/dashboard" }, { redirectedTo: "/dashboard" }]);
    const saved = await movieOf(user.id);
    expect(["First", "Second"]).toContain(saved);
    // And it stays that way: a third submit cannot change it.
    await submit({ movie: "Third" });
    expect(await movieOf(user.id)).toBe(saved);
  });

  // Postgres cannot store a NUL byte in text. A crafted request must end as
  // a saved, cleaned title, not as a server error.
  it("survives control characters in a crafted request", async () => {
    const user = await createUser("a@example.com");
    signInAs(user);

    const result = await submit({ movie: "Al\u0000ien\u0007" });

    expect(result).toEqual({ redirectedTo: "/dashboard" });
    expect(await movieOf(user.id)).toBe("Alien");
  });
});

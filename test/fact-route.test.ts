import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FactError, FactSuccess } from "@/lib/facts/contract";

// The route is tested in isolation: the session and the service are mocked,
// so this checks only how the route decides who the user is and how it maps
// outcomes to HTTP. Real Google sign-in is not exercised anywhere in tests.
const { auth, getFact } = vi.hoisted(() => ({ auth: vi.fn(), getFact: vi.fn() }));
vi.mock("@/auth", () => ({ auth }));
vi.mock("@/lib/facts/service", () => ({ getFact }));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));

const { GET } = await import("@/app/api/fact/route");

const SUCCESS: FactSuccess = {
  fact: { id: "f1", movie: "Alien", text: "A fact.", createdAt: "2026-01-01T12:00:00.000Z" },
  status: "fresh",
  freshForMs: 60_000,
};

// GET takes no arguments: the request (query string, body) is never read.
// These requests document what an attacker might send.
const call = GET as unknown as (req: Request) => Promise<Response>;

beforeEach(() => {
  auth.mockReset();
  getFact.mockReset();
});

describe("GET /api/fact", () => {
  it("returns 401 without a session and never looks up a fact", async () => {
    auth.mockResolvedValue(null);

    const res = await call(new Request("http://localhost/api/fact?userId=alice"));

    expect(res.status).toBe(401);
    expect(((await res.json()) as FactError).error.code).toBe("UNAUTHENTICATED");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(getFact).not.toHaveBeenCalled();
  });

  it("uses the session's user and ignores a ?userId= for someone else", async () => {
    auth.mockResolvedValue({ user: { id: "bob" } });
    getFact.mockResolvedValue({ type: "success", body: SUCCESS });

    const res = await call(new Request("http://localhost/api/fact?userId=alice"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SUCCESS);
    expect(getFact).toHaveBeenCalledOnce();
    expect(getFact.mock.calls[0][0]).toBe("bob");
  });

  it.each([
    [{ type: "no_movie" }, 409, "NO_MOVIE"],
    [{ type: "generation_failed" }, 503, "GENERATION_FAILED"],
  ])("maps %o to %i", async (outcome, status, code) => {
    auth.mockResolvedValue({ user: { id: "bob" } });
    getFact.mockResolvedValue(outcome);

    const res = await call(new Request("http://localhost/api/fact"));

    expect(res.status).toBe(status);
    expect(((await res.json()) as FactError).error.code).toBe(code);
  });

  it.each([
    ["an empty session object", {}],
    ["a session whose user has no id", { user: { email: "a@example.com" } }],
    ["a session with an empty id", { user: { id: "" } }],
  ])("returns 401 for %s", async (_label, session) => {
    auth.mockResolvedValue(session);

    const res = await call(new Request("http://localhost/api/fact"));

    expect(res.status).toBe(401);
    expect(getFact).not.toHaveBeenCalled();
  });

  // The session lookup is a database query too. If the database is down it is
  // the first thing to fail, and the client must still get the documented
  // JSON error rather than a bare 500.
  it("answers with the generic 503 when the session lookup itself fails", async () => {
    auth.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await call(new Request("http://localhost/api/fact"));
    const body = (await res.json()) as FactError;

    expect(res.status).toBe(503);
    expect(body.error.code).toBe("GENERATION_FAILED");
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(getFact).not.toHaveBeenCalled();
  });

  it("hides unexpected errors behind a generic 503", async () => {
    auth.mockResolvedValue({ user: { id: "bob" } });
    getFact.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await call(new Request("http://localhost/api/fact"));
    const body = (await res.json()) as FactError;

    expect(res.status).toBe(503);
    expect(body.error.code).toBe("GENERATION_FAILED");
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
  });
});

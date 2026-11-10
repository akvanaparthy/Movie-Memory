import { describe, expect, it } from "vitest";
import { toPublicSession } from "@/lib/public-session";

// What Auth.js really passes to the session callback with database sessions:
// the Session row (with the user attached) and the whole User row.
const userRow = {
  id: "u1",
  name: "Ada Lovelace",
  email: "ada@example.com",
  emailVerified: new Date("2026-01-01T00:00:00.000Z"),
  image: "https://lh3.googleusercontent.com/a/photo",
  favoriteMovie: "Alien",
  factRetryAfter: new Date("2026-01-01T12:00:15.000Z"),
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};
const sessionRow = {
  sessionToken: "the-raw-session-token",
  userId: "u1",
  expires: new Date("2026-02-01T00:00:00.000Z"),
  user: userRow,
};

describe("toPublicSession (the body of /api/auth/session)", () => {
  it("returns the id, name, email, photo and expiry, and nothing else", () => {
    expect(toPublicSession(sessionRow, userRow)).toEqual({
      expires: "2026-02-01T00:00:00.000Z",
      user: {
        id: "u1",
        name: "Ada Lovelace",
        email: "ada@example.com",
        image: "https://lh3.googleusercontent.com/a/photo",
      },
    });
  });

  // The token lives in an HttpOnly cookie so scripts cannot read it. Echoing
  // it in a JSON body would hand it to any script on the page.
  it("never echoes the session token or any other column", () => {
    const body = JSON.stringify(toPublicSession(sessionRow, userRow));

    for (const leaked of ["the-raw-session-token", "sessionToken", "favoriteMovie", "Alien", "factRetryAfter", "emailVerified"]) {
      expect(body).not.toContain(leaked);
    }
  });

  it("uses null for a Google account with no name or photo", () => {
    const bare = { id: "u2", email: "bare@example.com" };

    expect(toPublicSession(sessionRow, bare).user).toEqual({
      id: "u2",
      name: null,
      email: "bare@example.com",
      image: null,
    });
  });

  it("passes through an expiry that is already a string", () => {
    const expires = "2026-02-01T00:00:00.000Z";

    expect(toPublicSession({ expires }, userRow).expires).toBe(expires);
  });
});

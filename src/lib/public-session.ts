/** The only session shape that leaves the server. */
export type PublicSession = {
  expires: string;
  user: { id: string; name: string | null; email: string; image: string | null };
};

type SessionRow = { expires: Date | string };
type UserRow = { id: string; name?: string | null; email: string; image?: string | null };

/**
 * Auth.js hands its session callback the whole Session and User rows, and
 * sends whatever the callback returns to the browser as JSON from
 * `/api/auth/session`. Returning those rows would publish the session token
 * (defeating its HttpOnly cookie) and every column on User, so the result is
 * built field by field instead.
 */
export function toPublicSession(session: SessionRow, user: UserRow): PublicSession {
  const expires =
    session.expires instanceof Date ? session.expires.toISOString() : session.expires;
  return {
    expires,
    user: {
      id: user.id,
      name: user.name ?? null,
      email: user.email,
      image: user.image ?? null,
    },
  };
}

import "server-only";
import { PrismaAdapter } from "@auth/prisma-adapter";
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { getDb } from "@/lib/db";

// The config is a function so the database client (and DATABASE_URL) is only
// needed when a request actually reaches Auth.js, not when this module loads
// during `next build`.
//
// Google reads AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET, and Auth.js reads
// AUTH_SECRET, from the environment by convention.
export const { handlers, auth, signIn, signOut } = NextAuth(() => ({
  adapter: PrismaAdapter(getDb()),
  providers: [Google],
  // Sessions are rows in the Session table, so signing out or deleting a user
  // revokes access immediately (a JWT would stay valid until it expires).
  session: { strategy: "database" },
  callbacks: {
    // With database sessions the default session omits the user id.
    session({ session, user }) {
      session.user.id = user.id;
      return session;
    },
  },
}));

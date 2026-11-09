# Movie Memory

Sign in with Google, name your favorite movie, and get a fun fact about it from OpenAI. A new fact is generated at most once a minute per user, however many tabs or refreshes ask for one.

**Variant chosen: A, backend-focused (caching and correctness).** [Why](#why-variant-a) is below.

## Setup

You need Node 22.12+ (built on Node 24), a Postgres database, a Google OAuth client and an OpenAI API key.

```bash
npm install            # also generates the Prisma client
cp .env.example .env   # then fill it in, see the table below
npm run db:migrate     # applies prisma/migrations to your database
npm run dev            # http://localhost:3000
```

Tests need no setup at all:

```bash
npm test               # boots its own throwaway Postgres, applies the migration, runs 20 tests
```

Also available: `npm run lint`, `npm run typecheck`, `npm run build`.

## Environment variables

| Variable | Required | What it is |
| --- | --- | --- |
| `OPENAI_API_KEY` | yes | From platform.openai.com. Server-side only. |
| `OPENAI_MODEL` | no | Overrides the model used for facts. Defaults to `gpt-6-luna`. |
| `DATABASE_URL` | yes | The connection the app uses. On Neon, the pooled string (host contains `-pooler`). |
| `DIRECT_URL` | on Neon | The direct (unpooled) string, used only for migrations. Falls back to `DATABASE_URL` when unset. |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | yes | A Google OAuth client of type "Web application" with the redirect URI `http://localhost:3000/api/auth/callback/google`. |
| `AUTH_SECRET` | yes | Signs session cookies. Generate one with `npx auth secret`. |
| `TEST_DATABASE_URL` | no | Run the tests against your own Postgres instead of the embedded one. It gets wiped. |

## Database migrations

- `npm run db:migrate` runs `prisma migrate deploy`, which applies everything in `prisma/migrations` (currently one migration, `20261109000000_init`).
- To change the schema: edit `prisma/schema.prisma`, then `npx prisma migrate dev --name <what-changed>`.
- The test suite applies the same migration with the same command to an empty database on every run, so the migration itself is tested.

## Architecture

```
Browser
  /             landing ── Sign in with Google ──► Auth.js (/api/auth/*) ──► Google
  /onboarding   first visit only: save the favorite movie (server action)
  /dashboard    profile + the movie's title card; the client calls GET /api/fact
                                    │
                        src/lib/facts/service.ts   getFact(userId)
                          ├─ Postgres via Prisma:  User, Fact, FactLease
                          └─ OpenAI:               one call per user per burst
```

| Path | Responsibility |
| --- | --- |
| `src/auth.ts` | Auth.js v5: Google provider, Prisma adapter, database sessions. |
| `src/lib/session.ts` | `getCurrentUser()` / `requireUser()`: the only way pages learn who is signed in. |
| `src/lib/actions.ts` | Server actions: save the movie, sign in, sign out. |
| `src/lib/movie.ts` | Movie title validation (zod). |
| `src/lib/facts/` | The variant: `service.ts` (the algorithm), `lease.ts` (burst guard), `freshness.ts` (the 60-second rule), `generate.ts` (OpenAI), `timings.ts` (the numbers), `contract.ts` (the API's types, shared with the client). |
| `src/app/api/fact/route.ts` | `GET /api/fact`: session to user id, outcome to HTTP status. |
| `src/app/**/page.tsx`, `src/components/` | The three pages and their UI. |
| `test/` | Vitest: the fact service against real Postgres, the route handler, validation. |

### Auth flow

- Auth.js v5 with Google and **database sessions**. A session is a row, so signing out revokes it immediately; a JWT would stay valid until it expired.
- There is no middleware. Each page, server action and route handler checks the session itself, next to the data it protects. A check that lives only in middleware is one misconfigured matcher away from not running.
- Routing rules, all enforced on the server:
  - `/` signed in: redirect to `/dashboard`, or `/onboarding` if no movie yet.
  - `/onboarding` signed out: redirect to `/`. Movie already saved: redirect to `/dashboard`.
  - `/dashboard` signed out: redirect to `/`. No movie yet: redirect to `/onboarding`.
- "First-time user" is not a separate flag. It is `User.favoriteMovie IS NULL`, so there is nothing that can drift out of sync with the data.
- Next 16 enables Cache Components by default, which wants session reads behind a `<Suspense>` boundary. A redirect from inside a streamed boundary is sent as a meta tag after a 200. I wanted real redirects, so the three pages export `instant = false` and render per request: signed-out `GET /dashboard` returns a 307.

### Data model

```
User       id, name?, email, image?, favoriteMovie?            (+ Auth.js Account, Session)
Fact       id, userId → User, movie, text, model, createdAt    index (userId, movie, createdAt DESC)
FactLease  userId (PK) → User, token, expiresAt
```

- `favoriteMovie` is a nullable column on `User`: one user has one favorite, and null carries the onboarding state.
- `Fact.movie` is a snapshot of the title the fact was written for. Facts stay truthful if the favorite ever changes, and "latest fact for this user and movie" is a single index lookup.
- I did not add a `Movie` table. Titles are free text with no catalog behind them, so a table would add a join without adding integrity.
- `Fact.createdAt` has no database default. The app clock writes it and the same clock judges its age.
- `FactLease` has `userId` as its primary key, so the database itself guarantees at most one lease per user.

### Fact generation (the variant)

`getFact(userId)` in `src/lib/facts/service.ts`:

1. Load the user's movie. None: `NO_MOVIE`.
2. Find the latest fact for this user and movie. Under 60 seconds old: return it as `cached`. At exactly 60 000 ms it is no longer fresh.
3. Otherwise try to take the user's lease with one atomic statement:
   ```sql
   INSERT INTO "FactLease" (...) VALUES (...)
   ON CONFLICT ("userId") DO UPDATE SET token = ..., "expiresAt" = ...
     WHERE "FactLease"."expiresAt" <= $now
   RETURNING token
   ```
   A row back means the lease is ours (new, or taken over from an expired one). No row means another request is already generating.
4. **The holder** re-checks for a fresh fact (one may have landed between steps 2 and 3), calls OpenAI outside any transaction, stores the fact and returns it as `fresh`. It releases the lease in `finally`, and only if the token is still its own.
5. **Everyone else** polls every 250 ms. When the holder's fact appears they return it as `cached`. They never call OpenAI, so ten tabs cost one call, including when that call fails.
6. **On failure** (timeout, error, empty or truncated reply) return the most recent older fact as `stale`, or `GENERATION_FAILED` if there is none.

Why this is safe under concurrency:

- Two requests cannot both take the lease. Postgres serializes them on the primary key, and the second one's `WHERE` sees the first one's unexpired row.
- The OpenAI timeout is 10 s with retries off, and the lease lasts 30 s, so a healthy holder always finishes or gives up before its lease can expire. The expiry exists only so a process that dies mid-call cannot lock a user out forever.
- The tests prove the burst case against real Postgres: 10 concurrent calls, exactly one generator call, one row written, all 10 get the same fact.

`GET /api/fact` responses (types in `src/lib/facts/contract.ts`):

| Status | Body | When |
| --- | --- | --- |
| 200 | `{ fact, status: "fresh" \| "cached" \| "stale", freshForMs }` | A fact to show. |
| 401 | `{ error: { code: "UNAUTHENTICATED" } }` | No session. |
| 409 | `{ error: { code: "NO_MOVIE" } }` | Onboarding not finished. |
| 503 | `{ error: { code: "GENERATION_FAILED" } }` | OpenAI failed and there is no earlier fact. |

### OpenAI integration

- The key is read in a `server-only` module and never reaches a client bundle. Environment variables are validated lazily, by name, never by value.
- Explicit 10 s timeout and zero retries, because the lease timing depends on a bounded call.
- The movie title is untrusted input. It is never placed in the instructions; it is passed as delimited data, with angle brackets stripped so it cannot close the delimiter, and the model is told to treat it as a title only.
- Output is capped at 120 tokens. A reply that did not complete is treated as a failure, so a half sentence is never stored.
- Facts are rendered as plain text by React, so model output cannot inject markup.

### Security and correctness

- **Other users' data:** no endpoint accepts a user id. The route handler does not read the request at all; identity comes only from the session. Every fact query is scoped by `userId`, and tests cover both the fresh and the stale path with two users who share a movie.
- **Validation:** the movie title is validated on the server (trim, collapse whitespace, 1 to 100 characters). The form's `maxLength` is a convenience.
- **Server actions** are public endpoints, so `saveFavoriteMovie` re-reads the session and re-validates. Its update only matches rows where the movie is still null, so a replayed submit cannot overwrite.
- **Responses** from `/api/fact` are `Cache-Control: no-store`. Unexpected errors are logged on the server and returned as a generic message.
- **Missing Google name or photo:** the email stands in for the name and an initial stands in for the photo, including when the photo URL fails to load.

### Frontend

The app is one lit cinema screen in a dark room. The landing page shows the product's title card, onboarding has you type your movie onto the card, and the dashboard shows that card with the fact as its subtitle.

The UI's job in this variant is to show the server's state honestly:

- A line along the bottom of the screen runs for the 60-second window, and "New fact" unlocks when it ends. Both come from `freshForMs`, a relative duration, so a wrong client clock cannot distort them.
- `stale` and `GENERATION_FAILED` each have their own plain-language state and a "Try again".
- The client lock is not enforcement. Asking early is harmless because the server returns the cached fact.

Tailwind 4 with design tokens in `globals.css`, one variable font (Archivo, using its width axis), and no UI library.

## Why Variant A

The part of this app that can go wrong in production is the OpenAI call: it is slow, it costs money, it fails, and it sits behind a page people refresh. Getting that right means a correct cache window, one call per burst, and a sane answer when the provider is down. That is the same shape of problem as any integration with an external API, which is what this role works on, so it is where I wanted to spend the depth.

## Key tradeoffs

- **A lease row, not the alternatives.** An in-memory lock breaks with more than one server instance, which is every serverless deployment. A transaction held open across the OpenAI call would pin a pooled connection for seconds per waiting tab. A unique constraint per 60-second bucket gives fixed windows, not a sliding one. The lease costs one small table and one raw SQL statement.
- **Waiters poll.** Every 250 ms for at most 12 s. `LISTEN/NOTIFY` would be more elegant but does not work through a transaction-mode pooler such as Neon's.
- **App clock, not database clock.** One injected clock stamps facts and judges their age, which makes the 59 999 / 60 000 ms boundary testable. Across several instances it assumes server clocks agree to well within the 30 s lease.
- **`GET` with a side effect.** `GET /api/fact` may generate and store a fact. It behaves as a read-through cache and is idempotent within the window, which is what makes refreshes safe.
- **Blocking pages over streaming.** `instant = false` gives real HTTP redirects at the cost of Next 16's instant static shell. Every page here is per-user, so there was little shell to lose.
- **Database sessions over JWT.** Revocable, at the cost of a session lookup per request.
- **The movie cannot be edited** after onboarding. Inline editing belongs to Variant B. Because of that, `Fact.movie` matching is exact text; an edit flow would need a normalized key.
- **No failure backoff.** While OpenAI is down, each new burst makes one attempt and waits up to 10 s for it.
- **Facts are not fact-checked.** The prompt asks for accuracy and for honesty about unknown titles, but nothing verifies what the model writes.
- **Auth.js v5 is still tagged beta.** It is the version built for the App Router, and I pinned the exact release.
- **Tests run on an embedded Postgres.** Real SQL semantics with zero setup, at the cost of a binary download on `npm install`.

## With two more hours

1. A short backoff after an OpenAI failure, so an outage serves `stale` immediately instead of retrying on every burst.
2. Send the user's previous facts with the prompt so a new fact is never a repeat.
3. Show fact history on the dashboard. The facts are already stored.
4. An edit-movie flow, with a normalized cache key.
5. An end-to-end test of the sign-in and onboarding redirects against a mocked OAuth provider.
6. A scheduled cleanup of expired sessions, and structured logs with a request id.

## AI usage

- I used Claude Code (Anthropic) throughout, as a pair programmer working from briefs I approved.
- **Planning:** comparing the two variants and the four burst-protection options in the brief, and settling on the lease design, the schema and the API contract before any code was written.
- **Current docs:** several libraries changed recently (Next 16 Cache Components and `proxy.ts`, Prisma 7's config and driver adapters, Auth.js v5, the OpenAI Responses API), so the AI read the bundled and official docs instead of relying on memory.
- **Implementation:** most of the code and all of the tests were written by the AI, the backend and the frontend from separate briefs with a shared contract file between them.
- **Verification:** the AI ran lint, typecheck, the 20 tests and the production build, checked the signed-out redirects and API statuses over HTTP, and reviewed screenshots of every UI state at desktop and phone widths.

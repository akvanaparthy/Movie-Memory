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
npm test               # boots its own throwaway Postgres, applies the migrations, runs 95 tests
```

Also available: `npm run lint`, `npm run typecheck`, `npm run build`. GitHub Actions runs all four on every push (`.github/workflows/ci.yml`).

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

- `npm run db:migrate` runs `prisma migrate deploy`, which applies everything in `prisma/migrations` (currently two: `20261109000000_init` and `20261109010000_fact_retry_after`).
- To change the schema: edit `prisma/schema.prisma`, then `npx prisma migrate dev --name <what-changed>`.
- The test suite applies the same migrations with the same command to an empty database on every run, so the migrations themselves are tested.

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
| `src/lib/public-session.ts` | The only session fields that leave the server. |
| `src/lib/actions.ts` | Server actions: save the movie, sign in, sign out. |
| `src/lib/movie.ts`, `src/lib/text.ts` | Movie title validation (zod), and the text cleaning it shares with model output. |
| `src/lib/facts/` | The variant: `service.ts` (the algorithm), `lease.ts` (burst guard), `freshness.ts` (the 60-second rule), `generate.ts` (OpenAI), `timings.ts` (the numbers), `contract.ts` (the API's types, shared with the client). |
| `src/app/api/fact/route.ts` | `GET /api/fact`: session to user id, outcome to HTTP status. |
| `src/app/**/page.tsx`, `src/components/` | The three pages and their UI. |
| `test/` | Vitest: the fact service and the onboarding action against real Postgres, the route handler, the OpenAI call, validation. See [Testing](#testing). |

### Auth flow

- Auth.js v5 with Google and **database sessions**. A session is a row, so signing out revokes it immediately; a JWT would stay valid until it expired.
- There is no middleware. Each page, server action and route handler checks the session itself, next to the data it protects. A check that lives only in middleware is one misconfigured matcher away from not running.
- Routing rules, all enforced on the server:
  - `/` signed in: redirect to `/dashboard`, or `/onboarding` if no movie yet.
  - `/onboarding` signed out: redirect to `/`. Movie already saved: redirect to `/dashboard`.
  - `/dashboard` signed out: redirect to `/`. No movie yet: redirect to `/onboarding`.
- "First-time user" is not a separate flag. It is `User.favoriteMovie IS NULL`, so there is nothing that can drift out of sync with the data.
- The redirects are HTTP 307s sent before any HTML. That is why Cache Components, which the Next 16 scaffold turns on, is off here: with it on, a session read always streams behind a `<Suspense>` boundary, so a signed-out `GET /dashboard` answered 200 and redirected in the browser. `next dev` returned a 307 either way; only testing the production build showed the difference.
- `/api/auth/session` returns the user's id, name, email, photo and the expiry, and nothing else. Auth.js sends whatever the session callback returns, so that object is built field by field (`src/lib/public-session.ts`).

### Data model

```
User       id, name?, email, image?, favoriteMovie?, factRetryAfter?   (+ Auth.js Account, Session)
Fact       id, userId → User, movie, text, model, createdAt            index (userId, movie, createdAt DESC)
FactLease  userId (PK) → User, token, expiresAt
```

- `favoriteMovie` is a nullable column on `User`: one user has one favorite, and null carries the onboarding state.
- `factRetryAfter` is the failure cooldown: after a failed generation, no OpenAI call is made for that user before this time.
- `Fact.movie` is a snapshot of the title the fact was written for. Facts stay truthful if the favorite ever changes, and "latest fact for this user and movie" is a single index lookup.
- I did not add a `Movie` table. Titles are free text with no catalog behind them, so a table would add a join without adding integrity.
- `Fact.createdAt` has no database default. The app clock writes it and the same clock judges its age.
- `FactLease` has `userId` as its primary key, so the database itself guarantees at most one lease per user.

### Fact generation (the variant)

`getFact(userId)` in `src/lib/facts/service.ts`:

1. Load the user's movie. None: `NO_MOVIE`.
2. Find the latest fact for this user and movie. Under 60 seconds old: return it as `cached`. At exactly 60 000 ms it is no longer fresh.
3. If a generation failed for this user in the last 15 seconds (`User.factRetryAfter`), skip OpenAI and go straight to step 7.
4. Otherwise try to take the user's lease with one atomic statement:
   ```sql
   INSERT INTO "FactLease" (...) VALUES (...)
   ON CONFLICT ("userId") DO UPDATE SET token = ..., "expiresAt" = ...
     WHERE "FactLease"."expiresAt" <= $now
   RETURNING token
   ```
   A row back means the lease is ours (new, or taken over from an expired one). No row means another request is already generating.
5. **The holder** repeats checks 2 and 3 now that it holds the lease, because another request may have finished in between. It then calls OpenAI outside any transaction, sending the user's last 10 facts for this movie so the new one is not a repeat, stores the fact and returns it as `fresh`. It releases the lease in `finally`, and only if the token is still its own.
6. **Everyone else** polls every 250 ms. When the holder's fact appears they return it as `cached`. They never call OpenAI, so ten tabs cost one call, including when that call fails.
7. **On failure** (timeout, error, empty or truncated reply) the holder starts the 15-second cooldown for that user. The response is the most recent older fact as `stale`, or `GENERATION_FAILED` if there is none.

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
- Up to 10 earlier facts for the same user and movie are sent along so the model does not repeat itself. They are delimited and treated as data in the same way as the title.
- Output is capped at 120 tokens. A reply that did not complete is treated as a failure, so a half sentence is never stored. Line breaks are flattened and control characters dropped before a fact is stored.
- Facts are rendered as plain text by React, so model output cannot inject markup.

### Security and correctness

- **Other users' data:** no endpoint accepts a user id. The route handler does not read the request at all; identity comes only from the session. Every fact query is scoped by `userId`, and tests cover both the fresh and the stale path with two users who share a movie.
- **Validation:** the movie title is validated on the server: whitespace collapsed, control characters dropped (Postgres cannot store a NUL byte, so one used to turn a submit into a server error), 1 to 100 characters, and at least one visible character, so a title made of zero-width characters is refused. The form's `maxLength` is a convenience.
- **Server actions** are public endpoints, so `saveFavoriteMovie` re-reads the session and re-validates. Its update only matches rows where the movie is still null, so a replayed submit cannot overwrite. Next.js rejects a cross-site post to it.
- **Responses** from `/api/fact` are `Cache-Control: no-store`. Unexpected errors, including the database being down during the session lookup, are logged on the server and returned as the same generic JSON 503.
- **Headers:** every response forbids framing (`frame-ancestors 'none'`, `X-Frame-Options: DENY`) and content sniffing, and limits the referrer.
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
- **App clock, not database clock.** One injected clock stamps facts and judges their age, which makes the 59 999 / 60 000 ms boundary testable. Across several instances it assumes server clocks agree to well within the 30 s lease. A fact stamped by a faster clock counts as fresh for at most one full window, never longer.
- **`GET` with a side effect.** `GET /api/fact` may generate and store a fact. It behaves as a read-through cache and is idempotent within the window, which is what makes refreshes safe.
- **Per-request pages over Cache Components.** Turning it off gives real HTTP redirects and simpler pages, at the cost of Next 16's instant static shell. Every page here is per-user, so there was little shell to lose. It is also a choice with an end date: the Next docs say Cache Components becomes the only mode in the next major version, and at that point the signed-out redirect would move into `proxy.ts`.
- **No script policy.** The headers stop framing and sniffing, but there is no `script-src` Content Security Policy. A strict one needs a per-request nonce, which means `proxy.ts`.
- **Database sessions over JWT.** Revocable, at the cost of a session lookup per request.
- **The movie cannot be edited** after onboarding. Inline editing belongs to Variant B. Because of that, `Fact.movie` matching is exact text; an edit flow would need a normalized key.
- **The failure cooldown is per user and short.** After a failed call, that user's requests skip OpenAI for 15 s and get the fallback at once, instead of each waiting up to 10 s on a call that will fail. It does not stop other users from each making one failing call; a breaker shared across users would. It is short because the UI shows no countdown for it.
- **Facts are not fact-checked.** The prompt asks for accuracy and for honesty about unknown titles, but nothing verifies what the model writes.
- **Auth.js v5 is still tagged beta.** It is the version built for the App Router, and I pinned the exact release.
- **Tests run on an embedded Postgres.** Real SQL semantics with zero setup, at the cost of a binary download on `npm install`.

## Testing

`npm test` runs 95 tests. The fact service and the onboarding action run against real Postgres with a fake clock and a fake OpenAI; the route handler, the OpenAI call and validation are tested on their own. Beyond the cache boundary and the 10-request burst, they cover the cases a hostile or unlucky user would hit: a holder that hangs, crashes or overruns its lease, a failed OpenAI call, a failed database write, a failed session lookup, clock skew between servers, two simultaneous onboarding submits, forged form fields, and titles made of markup, control characters or nothing visible.

The app was also checked by hand against the production build (`next build`, `next start`) with real Postgres and real OpenAI:

- **Cache window in real time:** 17 requests spread across the window made 2 OpenAI calls. A fact was still served at 59 s old and replaced at 60.5 s.
- **Load:** 300 simultaneous requests for one user with nothing cached produced one OpenAI call, one stored fact and no errors.
- **Real failure:** with an invalid model name, the first request failed on the real OpenAI error and the next was answered from the cooldown without calling OpenAI.
- **Red team:** markup in a title is escaped; titles written as prompt injections were not obeyed and leaked no instructions; expired, made-up and SQL-shaped session tokens get a 401; a query string cannot select another user or movie; a sign-out `callbackUrl` pointing at another site is not followed; a cross-site post to the onboarding action is rejected and saves nothing.

That pass found seven defects that the first, all-green test suite had missed. All are fixed. Six now have a regression test; the first needs a running production build, so it was re-checked by hand over HTTP for every signed-in and signed-out combination.

1. In production, a signed-out `GET /dashboard` answered 200 and redirected in the browser. It was a 307 only in `next dev`.
2. A NUL byte in a movie title became a Postgres error and a 500 on the onboarding submit.
3. A title made only of zero-width characters was accepted.
4. `/api/auth/session` returned the whole user row and the raw session token.
5. With the database down, `/api/fact` answered a bare 500 instead of its documented JSON error.
6. A fact stamped by a server with a faster clock reported more than 60 s of freshness.
7. No response carried security headers.

## With two more hours

1. A circuit breaker shared across users, so an OpenAI outage costs one failing call in total instead of one per user.
2. Tell the client when the next attempt is allowed, so "Try again" can show a countdown during the cooldown.
3. Show fact history on the dashboard. The facts are already stored.
4. An edit-movie flow, with a normalized cache key.
5. An end-to-end test of the sign-in and onboarding redirects against a mocked OAuth provider.
6. A strict script Content Security Policy with nonces, a scheduled cleanup of expired sessions, and structured logs with a request id.

## AI usage

The code and the tests were written by an AI coding agent (Claude Code). I did not write them by hand. My part was to set the direction, approve each plan before anything changed, test the result, and send work back when it was not good enough.

- **Direction.** I had the agent put a plan to me before writing anything: the variant, the lease design, the schema, the API contract and a visual direction. I changed two things in that plan. I rejected the visual direction and asked for an interface with its own identity, and I asked for hosted Postgres so the app could be deployed.
- **Approval before changes.** The agent works under a standing rule: present the change, then wait for my go-ahead. Each later round of work, the additions and the fixes below, was proposed first and built only after I approved it.
- **Holding it to the brief.** Once it worked, I had the agent set out what the brief asked for against what had been built, and justify Variant A against B.
- **Scope.** I then asked what would make the variant stronger and approved three additions: the failure cooldown, sending earlier facts so they are not repeated, and CI.
- **My own check.** I created the Google OAuth client, signed in with a real account, went through onboarding, and watched the fact stay the same inside a minute and change after it.
- **Sending the tests back.** The first suite had 25 passing tests. I judged them too comfortable: happy paths and obvious boundaries. I had the suite rewritten around hostile and unlucky input, asked for a load test and a red-team pass against the production build, and reviewed the tests by hand instead of trusting a green run. That is what found the seven defects listed under [Testing](#testing).

What the AI did beyond writing the code: it read the current docs for libraries that changed recently (Next 16, Prisma 7, Auth.js v5, the OpenAI Responses API) instead of relying on memory, ran lint, typecheck, the tests and the production build, and ran the load and red-team checks above.

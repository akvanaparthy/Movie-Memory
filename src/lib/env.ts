import "server-only";
import { z } from "zod";

// Validated lazily, on first use, so `next build` and the tests run without
// real secrets. A missing variable fails the request that needs it, by name.
//
// Auth.js reads AUTH_SECRET, AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET from the
// environment itself, so they are not listed here.
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1).optional(),
});

type Env = z.infer<typeof schema>;

export function getEnv<K extends keyof Env>(name: K): Env[K] {
  const result = schema.shape[name].safeParse(emptyToUndefined(process.env[name]));
  if (!result.success) {
    // Name the variable, never its value.
    throw new Error(`Missing or invalid environment variable: ${name}`);
  }
  return result.data as Env[K];
}

// `.env` placeholders like `OPENAI_MODEL=` arrive as "", which means "unset".
function emptyToUndefined(value: string | undefined) {
  return value === "" ? undefined : value;
}

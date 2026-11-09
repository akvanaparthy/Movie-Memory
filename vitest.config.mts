import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": src,
      // `server-only` throws when imported outside a React Server Components
      // build. Tests run server code directly, so it becomes a no-op here.
      "server-only": fileURLToPath(new URL("./test/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // The DB-backed tests share one database and truncate it between tests.
    fileParallelism: false,
    // Booting Postgres the first time can take a few seconds.
    hookTimeout: 60_000,
  },
});

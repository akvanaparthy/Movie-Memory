import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("response headers", () => {
  it("forbids framing and content sniffing on every path", async () => {
    const rules = await nextConfig.headers!();
    const everyPath = rules.find((rule) => rule.source === "/:path*");
    const headers = Object.fromEntries(everyPath!.headers.map((h) => [h.key, h.value]));

    expect(headers).toMatchObject({
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
  });
});

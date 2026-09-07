import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveOtpSourceHash } from "@/lib/otp/sourceIdentity";

const secret = "s".repeat(32);

function expectedHash(source) {
  return createHmac("sha256", secret).update(source, "utf8").digest("hex");
}

describe("deriveOtpSourceHash", () => {
  it("uses Vercel's platform header only in a configured Vercel runtime", () => {
    const request = new Request("https://soulclinc.net/api/otp/challenge", {
      headers: {
        "x-vercel-forwarded-for": "203.0.113.9",
        "x-forwarded-for": "198.51.100.7",
      },
    });
    const hash = deriveOtpSourceHash(request, {
      env: { NODE_ENV: "production", VERCEL: "1", OTP_SOURCE_HASH_SECRET: secret },
    });

    expect(hash).toBe(expectedHash("203.0.113.9"));
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain("203.0.113.9");
  });

  it("normalizes equivalent IPv6 platform values into one bucket", () => {
    const options = {
      env: { NODE_ENV: "production", VERCEL: "1", OTP_SOURCE_HASH_SECRET: secret },
    };
    const expanded = deriveOtpSourceHash(
      new Request("https://example.com", {
        headers: { "x-vercel-forwarded-for": "2001:0db8:0000:0000:0000:0000:0000:0001" },
      }),
      options,
    );
    const compressed = deriveOtpSourceHash(
      new Request("https://example.com", {
        headers: { "x-vercel-forwarded-for": "2001:db8::1" },
      }),
      options,
    );

    expect(expanded).toBe(compressed);
    expect(compressed).toBe(expectedHash("2001:db8::1"));
  });

  it("does not let forwarded headers choose development buckets", () => {
    const first = deriveOtpSourceHash(
      new Request("http://localhost", { headers: { "x-forwarded-for": "1.1.1.1" } }),
      { env: { NODE_ENV: "development", OTP_SOURCE_HASH_SECRET: secret } },
    );
    const second = deriveOtpSourceHash(
      new Request("http://localhost", { headers: { "x-forwarded-for": "8.8.8.8" } }),
      { env: { NODE_ENV: "development", OTP_SOURCE_HASH_SECRET: secret } },
    );

    expect(first).toBe(second);
    expect(first).toBe(expectedHash("development-local-source"));
  });

  it.each([
    [{ NODE_ENV: "production", OTP_SOURCE_HASH_SECRET: secret }, { "x-forwarded-for": "1.1.1.1" }],
    [
      { NODE_ENV: "production", VERCEL: "1", OTP_SOURCE_HASH_SECRET: secret },
      { "x-vercel-forwarded-for": "bad-ip" },
    ],
    [
      { NODE_ENV: "production", VERCEL: "1", OTP_SOURCE_HASH_SECRET: secret },
      { "x-vercel-forwarded-for": "203.0.113.9, 198.51.100.7" },
    ],
    [
      { NODE_ENV: "production", VERCEL: "1" },
      { "x-vercel-forwarded-for": "203.0.113.9" },
    ],
    [{ NODE_ENV: "development" }, {}],
  ])("fails closed when trusted source derivation is unavailable", (env, headers) => {
    expect(() =>
      deriveOtpSourceHash(new Request("https://example.com", { headers }), { env }),
    ).toThrowError(expect.objectContaining({ code: "OTP_SOURCE_UNAVAILABLE", status: 503 }));
  });
});

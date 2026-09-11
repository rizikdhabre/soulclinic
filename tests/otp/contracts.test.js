import { describe, expect, it } from "vitest";
import { assertOtpPurpose } from "@/lib/otp/constants";
import * as otpConstants from "@/lib/otp/constants";
import {
  createBearerToken,
  deriveBookingToken,
  hashBearerToken,
  otpSecretKey,
} from "@/lib/otp/crypto";

const env = { CUSTOMER_SESSION_SECRET: "s".repeat(48) };

describe("OTP contracts", () => {
  it("keeps mutable purpose membership private", () => {
    expect(otpConstants.OTP_PURPOSES).toBeUndefined();
    expect(otpConstants.OTP_PROVIDERS).toBeUndefined();
  });

  it.each(["booking", "login"])("accepts purpose %s", (purpose) => {
    expect(assertOtpPurpose(purpose)).toBe(purpose);
  });

  it.each([undefined, null, "", "admin", "booking ", "LOGIN", {}, ["login"], true])(
    "rejects purpose %j without coercion", (purpose) => {
      expect(() => assertOtpPurpose(purpose)).toThrowError(
        expect.objectContaining({ code: "INVALID_OTP_PURPOSE", status: 400 }),
      );
    },
  );

  it("generates distinct 256-bit URL-safe bearer tokens", () => {
    const tokens = Array.from({ length: 32 }, () => createBearerToken());
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
    }
  });

  it("uses the exact SHA-256 digest instead of storing a plaintext bearer", () => {
    expect(hashBearerToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const token = createBearerToken();
    expect(hashBearerToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashBearerToken(token)).not.toContain(token);
    expect(hashBearerToken(token)).not.toBe(hashBearerToken(`${token}x`));
  });

  it.each([undefined, null, "", "s".repeat(31), 123456789, {}, ["s".repeat(48)]])(
    "requires a configured string secret of at least 32 characters: %j", (secret) => {
      const invalidEnv = { CUSTOMER_SESSION_SECRET: secret };
      for (const operation of [
        () => otpSecretKey("receipt", invalidEnv),
        () => deriveBookingToken("challenge", invalidEnv),
      ]) {
        expect(operation).toThrowError(
          expect.objectContaining({ code: "OTP_SERVICE_NOT_CONFIGURED", status: 503 }),
        );
      }
    },
  );

  it("accepts the minimum secret and separates receipt and booking key domains", () => {
    const minimum = { CUSTOMER_SESSION_SECRET: "s".repeat(32) };
    expect(otpSecretKey("receipt", minimum)).toHaveLength(32);
    expect(otpSecretKey("receipt", env)).toEqual(otpSecretKey("receipt", env));
    expect(otpSecretKey("receipt", env)).not.toEqual(otpSecretKey("booking-grant", env));
    expect(otpSecretKey("receipt", env)).not.toEqual(otpSecretKey("receipt", minimum));
  });

  it("derives stable secret-bound booking tokens without reusing the challenge bearer", () => {
    const challengeToken = createBearerToken();
    const token = deriveBookingToken(challengeToken, env);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toBe(challengeToken);
    expect(deriveBookingToken(challengeToken, env)).toBe(token);
    expect(deriveBookingToken(createBearerToken(), env)).not.toBe(token);
    expect(deriveBookingToken(challengeToken, { CUSTOMER_SESSION_SECRET: "t".repeat(48) })).not.toBe(token);
  });
});

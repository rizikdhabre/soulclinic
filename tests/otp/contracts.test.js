import { describe, expect, it } from "vitest";
import {
  assertOtpPurpose,
  selectInitialOtpProvider,
} from "@/lib/otp/constants";
import * as otpConstants from "@/lib/otp/constants";
import {
  createBearerToken,
  hashBearerToken,
  safeCompareDevelopmentCode,
} from "@/lib/otp/crypto";

describe("OTP contracts", () => {
  it("keeps membership sets private", () => {
    expect(otpConstants.OTP_PURPOSES).toBeUndefined();
    expect(otpConstants.OTP_PROVIDERS).toBeUndefined();
  });

  it.each(["booking", "login"])("accepts purpose %s", (purpose) => {
    expect(assertOtpPurpose(purpose)).toBe(purpose);
  });

  it.each([undefined, null, "", "admin", "booking "])("rejects purpose %s", (purpose) => {
    expect(() => assertOtpPurpose(purpose)).toThrowError(
      expect.objectContaining({ code: "INVALID_OTP_PURPOSE", status: 400 }),
    );
  });

  it("uses development only when an explicit non-production code exists", () => {
    expect(selectInitialOtpProvider({ NODE_ENV: "development" })).toBe("firebase");
    expect(
      selectInitialOtpProvider({ NODE_ENV: "development", OTP_DEV_CODE: "654321" }),
    ).toBe("development");
    expect(
      selectInitialOtpProvider({ NODE_ENV: "development", OTP_DEV_CODE: " 654321 " }),
    ).toBe("development");
    expect(
      selectInitialOtpProvider({ NODE_ENV: "development", OTP_DEV_CODE: "123456" }),
    ).toBe("development");
    expect(
      selectInitialOtpProvider({ NODE_ENV: "production", OTP_DEV_CODE: "654321" }),
    ).toBe("firebase");
  });

  it("hashes bearer values and compares only an explicitly configured dev code", () => {
    expect(createBearerToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashBearerToken("plain-token")).toMatch(/^[a-f0-9]{64}$/);
    expect(hashBearerToken("plain-token")).not.toContain("plain-token");
    expect(safeCompareDevelopmentCode("654321", "654321")).toBe(true);
    expect(safeCompareDevelopmentCode("123456", "123456")).toBe(true);
    expect(safeCompareDevelopmentCode("12345", "123456")).toBe(false);
    expect(safeCompareDevelopmentCode("123456", undefined)).toBe(false);
  });
});

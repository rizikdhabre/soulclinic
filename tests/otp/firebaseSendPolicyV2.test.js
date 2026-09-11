import { describe, expect, it } from "vitest";
import { AuthErrorCodes } from "firebase/auth";
import {
  FIREBASE_FAILURE_CODES,
  classifyFirebaseSendFailure,
} from "@/lib/otp/firebaseSendPolicy";

const report = (code, stage = "send", provenance = "firebase_sdk") => ({ code, stage, provenance });

describe("Firebase send fallback boundary", () => {
  it("uses installed public SDK error names, except explicit backend UNKNOWN", () => {
    const publicCodes = new Set(Object.values(AuthErrorCodes));
    for (const code of FIREBASE_FAILURE_CODES.filter((code) => code.startsWith("auth/"))) {
      if (code !== "auth/unknown") expect(publicCodes.has(code), code).toBe(true);
    }
    expect(Object.isFrozen(FIREBASE_FAILURE_CODES)).toBe(true);
  });

  it.each(["auth/internal-error", "auth/network-request-failed", "auth/unknown"])("allows %s only for an explicit SDK send rejection, marked ambiguous", (code) => {
    expect(classifyFirebaseSendFailure(report(code))).toEqual({
      eligible: true, ambiguous: true, reason: "sdk_send_rejected_ambiguous",
    });
    for (const stage of ["initialize", "recaptcha_init", "recaptcha_render", "recaptcha_token", "confirm", "token", "lifecycle"]) {
      expect(classifyFirebaseSendFailure(report(code, stage)).eligible).toBe(false);
    }
    for (const provenance of [undefined, "client", "recaptcha_sdk", "timeout", "untrusted"]) {
      expect(classifyFirebaseSendFailure({ code, stage: "send", provenance }).eligible).toBe(false);
    }
  });

  it.each(["recaptcha/network-request-failed", "recaptcha/timeout"])("allows positive reCAPTCHA technical evidence %s only at identifiable verifier stages", (code) => {
    for (const stage of ["recaptcha_init", "recaptcha_render", "recaptcha_token"]) {
      expect(classifyFirebaseSendFailure(report(code, stage, "recaptcha_sdk"))).toEqual({
        eligible: true, ambiguous: false, reason: "recaptcha_technical_failure",
      });
      expect(classifyFirebaseSendFailure(report(code, stage, "client")).eligible).toBe(false);
    }
    expect(classifyFirebaseSendFailure(report(code)).eligible).toBe(false);
  });

  it.each([
    "auth/invalid-phone-number", "auth/missing-phone-number", "auth/invalid-verification-code",
    "auth/missing-verification-code", "auth/code-expired", "auth/invalid-verification-id",
    "auth/missing-verification-id", "auth/user-disabled", "auth/rejected-credential",
    "auth/captcha-check-failed", "auth/invalid-app-credential", "auth/missing-app-credential",
    "auth/missing-recaptcha-token", "auth/invalid-recaptcha-token", "auth/invalid-recaptcha-action",
    "auth/too-many-requests", "auth/quota-exceeded", "auth/billing-not-enabled",
    "auth/unauthorized-domain", "auth/invalid-api-key", "auth/operation-not-allowed",
    "auth/app-not-authorized", "auth/auth-domain-config-required", "auth/recaptcha-not-enabled",
    "auth/invalid-app-id", "auth/argument-error", "auth/timeout",
    "auth/phone-auth-disabled", "client/operation-pending", "client/unclassified",
  ])("never treats %s as send fallback permission", (code) => {
    for (const stage of ["send", "recaptcha_init", "recaptcha_render", "recaptcha_token", "confirm", "token"]) {
      for (const provenance of ["firebase_sdk", "recaptcha_sdk", "client"]) {
        expect(classifyFirebaseSendFailure(report(code, stage, provenance)).eligible).toBe(false);
      }
    }
  });

  it.each([null, undefined, {}, "auth/unknown", { message: "network error" },
    report("auth/something-new"), report("auth/NETWORK-REQUEST-FAILED"),
    { ...report("auth/unknown"), stage: "sending" },
    { ...report("auth/unknown"), detail: "private" },
    { ...report("auth/unknown"), code: "x".repeat(10000) },
  ])("fails closed for malformed or unbounded reports (%#)", (value) => {
    expect(classifyFirebaseSendFailure(value)).toEqual({ eligible: false, ambiguous: false, reason: "invalid_report" });
  });

  it("keeps pending operations ambiguous without granting fallback", () => {
    expect(classifyFirebaseSendFailure(report("client/operation-pending", "send", "client"))).toEqual({
      eligible: false, ambiguous: true, reason: "operation_pending",
    });
  });
});

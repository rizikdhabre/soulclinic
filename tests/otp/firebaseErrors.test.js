import { describe, expect, it } from "vitest";
import {
  classifyFirebaseSendError,
  isServerApprovedFallbackCode,
} from "@/lib/otp/firebaseErrors";

describe("Firebase send-error policy", () => {
  it.each([
    "auth/internal-error",
    "auth/quota-exceeded",
    "auth/captcha-check-failed",
    "auth/missing-app-credential",
    "auth/invalid-app-credential",
    "auth/network-request-failed",
    "auth/unknown",
    "auth/recaptcha-not-enabled",
    "auth/missing-recaptcha-token",
    "auth/invalid-recaptcha-token",
    "auth/invalid-recaptcha-action",
    "auth/missing-client-type",
    "auth/missing-recaptcha-version",
    "auth/invalid-recaptcha-version",
    "auth/invalid-req-type",
  ])("allows technical SEND fallback for %s", (code) => {
    expect(classifyFirebaseSendError({ code })).toEqual({ action: "fallback", code });
    expect(isServerApprovedFallbackCode(code)).toBe(true);
  });

  it.each([
    "auth/invalid-verification-code",
    "auth/missing-verification-code",
    "auth/code-expired",
    "auth/too-many-requests",
    "auth/invalid-phone-number",
    "auth/user-disabled",
    "auth/app-not-authorized",
    "auth/operation-not-allowed",
    "auth/unauthorized-domain",
    "auth/invalid-api-key",
    "auth/argument-error",
    "auth/missing-phone-number",
    "auth/operation-not-supported-in-this-environment",
    "auth/recaptcha-check-failed",
    "OTP_RATE_LIMITED",
    "OTP_SOURCE_RATE_LIMITED",
    "OTP_FALLBACK_SOURCE_RATE_LIMITED",
    "OTP_REQUEST_IN_PROGRESS",
  ])("rejects fallback for %s", (code) => {
    expect(classifyFirebaseSendError({ code }).action).toBe("reject");
    expect(isServerApprovedFallbackCode(code)).toBe(false);
  });

  it("classifies direct string fallback and rejection codes", () => {
    expect(classifyFirebaseSendError("auth/quota-exceeded")).toEqual({
      action: "fallback",
      code: "auth/quota-exceeded",
    });
    expect(classifyFirebaseSendError("auth/invalid-phone-number")).toEqual({
      action: "reject",
      code: "auth/invalid-phone-number",
    });
  });

  it.each([
    {},
    null,
    undefined,
    new Error("reCAPTCHA client element has been removed"),
    new TypeError("reCAPTCHA setup failed"),
    { message: "Firebase: Error (auth/unknown)." },
  ])("rejects an uncoded failure without inferring an explicit auth/unknown: %s", (error) => {
    expect(classifyFirebaseSendError(error)).toEqual({
      action: "reject",
      code: "auth/unknown",
    });
  });

  it.each(["", { code: "" }, { code: null }, { code: 0 }, { code: {} }])(
    "rejects an empty or malformed code without upgrading it to explicit auth/unknown: %s",
    (error) => {
      expect(classifyFirebaseSendError(error).action).toBe("reject");
    },
  );

  it.each([
    "otp/recaptcha-setup-failed",
    { code: "otp/recaptcha-setup-failed" },
    {
      name: "FirebaseRecaptchaSetupError",
      code: "otp/recaptcha-setup-failed",
      stage: "recaptcha-setup",
      preSend: true,
    },
    Object.assign(new Error("setup failed"), { code: "otp/recaptcha-setup-failed" }),
  ])("does not accept a supplied internal code as client setup provenance: %s", (error) => {
    expect(classifyFirebaseSendError(error)).toEqual({
      action: "reject",
      code: "auth/unknown",
    });
  });

  it("approves only the fixed setup code for the server's existing challenge gates", () => {
    expect(isServerApprovedFallbackCode("otp/recaptcha-setup-failed")).toBe(true);
    expect(isServerApprovedFallbackCode("otp/recaptcha-other-failure")).toBe(false);
    expect(isServerApprovedFallbackCode({ code: "otp/recaptcha-setup-failed" })).toBe(false);
  });
});

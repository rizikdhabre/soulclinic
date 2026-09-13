import { describe, expect, it } from "vitest";
import { firebaseFailureDetails, firebaseErrorDiagnostic, projectFirebaseDiagnostic } from "@/lib/otp/firebaseDiagnostics";

describe("Firebase diagnostic classification, separate from fallback authorization", () => {
  it.each([
    ["auth/invalid-phone-number", "send", "firebase_sdk", "invalid_phone", "blocked"],
    ["auth/invalid-verification-code", "confirm", "firebase_sdk", "invalid_code", "blocked"],
    ["auth/code-expired", "confirm", "firebase_sdk", "expired_code", "blocked"],
    ["auth/invalid-verification-id", "confirm", "firebase_sdk", "verification_state", "blocked"],
    ["auth/missing-verification-id", "confirm", "firebase_sdk", "verification_state", "blocked"],
    ["auth/user-token-expired", "token", "firebase_sdk", "verification_state", "blocked"],
    ["auth/too-many-requests", "send", "firebase_sdk", "provider_throttle", "blocked"],
    ["auth/quota-exceeded", "send", "firebase_sdk", "quota_or_billing", "blocked"],
    ["auth/unauthorized-domain", "send", "firebase_sdk", "configuration", "blocked"],
    ["auth/captcha-check-failed", "send", "firebase_sdk", "app_verification", "blocked"],
    ["auth/user-disabled", "send", "firebase_sdk", "security_rejection", "blocked"],
    ["auth/internal-error", "send", "firebase_sdk", "technical_send", "eligible"],
    ["recaptcha/timeout", "recaptcha_token", "recaptcha_sdk", "technical_recaptcha", "eligible"],
    ["auth/network-request-failed", "initialize", "firebase_sdk", "technical_setup", "blocked"],
    ["auth/network-request-failed", "confirm", "firebase_sdk", "verification_technical", "blocked"],
    ["client/container-busy", "recaptcha_init", "client", "client_lifecycle", "blocked"],
    ["client/operation-pending", "send", "client", "pending", "blocked"],
    ["client/unclassified", "initialize", "client", "unclassified", "blocked"],
  ])("classifies %s at %s without widening fallback", (code, stage, provenance, failureCategory, fallbackDecision) => {
    expect(firebaseFailureDetails({ code, stage, provenance })).toMatchObject({ errorCode: code, failureStage: stage, failureProvenance: provenance, failureCategory, fallbackDecision });
  });

  it.each([null, undefined, {}, { code: "private-phone-token", stage: "private", provenance: "private" }])("unrecognized errors stay explicitly unclassified (%#)", (report) => {
    expect(firebaseFailureDetails(report, { boundary: "private", errorType: "private", message: "private" })).toEqual({
      errorCode: "client/unclassified", failureStage: "unknown", failureProvenance: "unknown", failureCategory: "unclassified", fallbackDecision: "blocked", fallbackReason: "invalid_report",
    });
  });

  it("never interprets a raw error message as fallback permission or retains it", () => {
    const error = new Error("auth/network-request-failed private-phone private-token");
    expect(firebaseErrorDiagnostic(error, "firebase_sdk_load")).toEqual({ boundary: "firebase_sdk_load", errorType: "Error" });
    expect(projectFirebaseDiagnostic({ boundary: "firebase_token", errorType: "TypeError", code: "123456", idToken: "private" })).toEqual({ boundary: "firebase_token", errorType: "TypeError" });
  });
});

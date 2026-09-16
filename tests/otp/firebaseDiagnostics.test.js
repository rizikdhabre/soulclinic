import { describe, expect, it } from "vitest";
import { AuthErrorCodes } from "firebase/auth";
import { firebaseFailureDetails, firebaseErrorDiagnostic, projectFirebaseDiagnostic } from "@/lib/otp/firebaseDiagnostics";

describe("Firebase diagnostic classification, separate from fallback authorization", () => {
  it("retains observed code 39 with its explicit exception rather than a generic technical label", () => {
    const code = "auth/error-code:-39";
    const diagnostic = firebaseErrorDiagnostic({ name: "FirebaseError", code, message: "private-token" }, "firebase_send");
    expect(diagnostic).toEqual({ boundary: "firebase_send", errorType: "FirebaseError", sdkErrorCode: code });
    expect(firebaseFailureDetails({ code, stage: "send", provenance: "firebase_sdk" }, diagnostic)).toMatchObject({
      errorCode: code, sdkErrorCode: code, failureCategory: "provider_code_39",
      fallbackDecision: "eligible", fallbackReason: "approved_code_39_send_rejection",
    });
    expect(firebaseFailureDetails({ code: "client/unclassified", stage: "send", provenance: "firebase_sdk" }, diagnostic))
      .toMatchObject({ fallbackDecision: "blocked" });
  });
  it.each([...new Set(Object.values(AuthErrorCodes))])("retains the public SDK identifier %s independently of fallback policy", (code) => {
    const diagnostic = firebaseErrorDiagnostic({ name: "FirebaseError", code, message: "private-token" }, "firebase_send");
    expect(diagnostic).toEqual({ boundary: "firebase_send", errorType: "FirebaseError", sdkErrorCode: code });
    expect(projectFirebaseDiagnostic(diagnostic)).toEqual(diagnostic);
    expect(firebaseFailureDetails({ code: "client/unclassified", stage: "send", provenance: "firebase_sdk" }, diagnostic))
      .toMatchObject({ errorCode: "client/unclassified", sdkErrorCode: code, fallbackDecision: "blocked", fallbackReason: "not_eligible" });
  });

  it.each(["654321", "+972521234567", "auth/private-token", "auth/" + "a".repeat(43),
    "auth/eyJhbGciOiJSUzI1NiJ9.payload.signature", "auth/internal-error\nprivate", "auth/internal-error?token=private",
    " auth/internal-error", "AUTH/INTERNAL-ERROR", { code: "auth/internal-error" }, ["auth/internal-error"]])(
    "redacts arbitrary values rather than treating namespaced data as SDK identifiers (%#)", (sdkErrorCode) => {
      expect(projectFirebaseDiagnostic({ sdkErrorCode })).toEqual({});
      expect(firebaseErrorDiagnostic({ name: "FirebaseError", code: sdkErrorCode }, "firebase_send"))
        .toEqual({ boundary: "firebase_send", errorType: "FirebaseError", sdkErrorCodeState: "redacted" });
    },
  );

  it("distinguishes a native Firebase error missing its code from a redacted identifier", () => {
    expect(firebaseErrorDiagnostic({ name: "FirebaseError" }, "firebase_send"))
      .toEqual({ boundary: "firebase_send", errorType: "FirebaseError", sdkErrorCodeState: "missing" });
    expect(projectFirebaseDiagnostic({ sdkErrorCodeState: "private-token" })).toEqual({});
  });

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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";

const sdk = vi.hoisted(() => {
  const send = vi.fn();
  const check = vi.fn();
  const services = vi.fn(() => ({
    verifications: { create: send }, verificationChecks: { create: check },
  }));
  const client = { verify: { v2: { services } } };
  return { send, check, services, client, twilio: vi.fn(() => client) };
});

vi.mock("twilio", () => ({ default: sdk.twilio }));

const PHONE = "+972500000001";
const SID = "VE0123456789abcdef0123456789abcdef";
const ACCOUNT = "mock-account-sid";
const SERVICE = "mock-service-sid";
const TOKEN = "private-auth-token";
const loadAdapter = () => import("@/lib/twilioOTP");
const loadClient = () => import("@/lib/twilio");

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("TWILIO_ACCOUNT_SID", ACCOUNT);
  vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
  vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", SERVICE);
  sdk.send.mockReset().mockResolvedValue({ sid: SID, status: "pending", to: PHONE, channel: "sms" });
  sdk.check.mockReset().mockResolvedValue({ sid: SID, status: "approved", to: PHONE });
  for (const method of ["log", "info", "warn", "error"]) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => vi.unstubAllEnvs());

describe("Twilio Verify adapter", () => {
  it("does not initialize the SDK during import", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    await loadAdapter();
    expect(sdk.twilio).not.toHaveBeenCalled();
  });

  it("caches a client with explicit disabled retries and a 15-second timeout", async () => {
    const { getTwilioClient } = await loadClient();
    expect(getTwilioClient()).toBe(getTwilioClient());
    expect(sdk.twilio).toHaveBeenCalledExactlyOnceWith(ACCOUNT, TOKEN, {
      autoRetry: false, timeout: 15000,
    });
  });

  it.each(["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_VERIFY_SERVICE_SID"])(
    "fails locally when %s is missing without exposing credentials",
    async (key) => {
      vi.stubEnv(key, "");
      const { sendTwilioVerification } = await loadAdapter();
      const error = await sendTwilioVerification(PHONE).catch((value) => value);
      expect(error).toMatchObject({ code: "TWILIO_VERIFY_NOT_CONFIGURED" });
      expect(inspect(error)).not.toContain(TOKEN);
      expect(inspect(error)).not.toContain(PHONE);
      expect(sdk.twilio).not.toHaveBeenCalled();
      expect(sdk.send).not.toHaveBeenCalled();
    },
  );

  it("sends an SMS only once using the configured service and stored phone", async () => {
    const { sendTwilioVerification } = await loadAdapter();
    const result = await sendTwilioVerification(PHONE);
    expect(sdk.services).toHaveBeenCalledExactlyOnceWith(SERVICE);
    expect(sdk.send).toHaveBeenCalledExactlyOnceWith({ to: PHONE, channel: "sms" });
    expect(result).toEqual({ sid: SID, status: "pending", to: PHONE, channel: "sms" });
    expect(sdk.check).not.toHaveBeenCalled();
  });

  it.each([SID, "VEABCDEF0123456789ABCDEF0123456789"])(
    "checks the exact stored verification SID %s, not the phone number",
    async (verificationSid) => {
      const { verifyTwilioCode } = await loadAdapter();
      await verifyTwilioCode(PHONE, "654321", verificationSid);
      expect(sdk.services).toHaveBeenCalledExactlyOnceWith(SERVICE);
      expect(sdk.check).toHaveBeenCalledExactlyOnceWith({ verificationSid, code: "654321" });
      expect(sdk.send).not.toHaveBeenCalled();
    },
  );

  it.each([
    undefined, null, "", "VEshort", "VA0123456789abcdef0123456789abcdef",
    "ve0123456789abcdef0123456789abcdef", "VE0123456789abcdef0123456789abcdeg",
    ` ${SID}`, `${SID}\n`, 123, { toString: () => SID },
  ])("rejects malformed SID %j before accessing configuration or the SDK", async (verificationSid) => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    const { verifyTwilioCode, classifyTwilioVerifyError } = await loadAdapter();
    const error = await verifyTwilioCode(PHONE, "654321", verificationSid).catch((value) => value);
    expect(error).toMatchObject({ code: "TWILIO_VERIFICATION_SID_INVALID" });
    expect(classifyTwilioVerifyError(error)).toMatchObject({ errorCode: "INVALID_OTP", retryable: false, unknown: false });
    expect(inspect(error)).not.toContain(PHONE);
    expect(inspect(error)).not.toContain("654321");
    expect(sdk.twilio).not.toHaveBeenCalled();
    expect(sdk.check).not.toHaveBeenCalled();
  });

  it.each(["approved", "pending", "expired", "failed", undefined])(
    "returns status %s unchanged so completion can validate status, SID and recipient",
    async (status) => {
      const raw = { sid: "VEabcdef0123456789abcdef0123456789", status, to: "+972500000002", valid: true };
      sdk.check.mockResolvedValue(raw);
      const { verifyTwilioCode } = await loadAdapter();
      expect(await verifyTwilioCode(PHONE, "654321", SID)).toBe(raw);
      expect(sdk.check).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["DNS failure", { code: "ENOTFOUND" }],
    ["timeout", { code: "ECONNABORTED" }],
    ["reset", { code: "ECONNRESET" }],
    ["5xx", { status: 503 }],
    ["rate limit", { status: 429 }],
    ["expired or already consumed", { status: 404, code: 20404 }],
  ])("never retries sends or checks automatically after %s", async (_name, fields) => {
    const error = Object.assign(new Error("private-provider-body"), fields);
    sdk.send.mockRejectedValue(error);
    sdk.check.mockRejectedValue(error);
    const { sendTwilioVerification, verifyTwilioCode } = await loadAdapter();
    await expect(sendTwilioVerification(PHONE)).rejects.toBe(error);
    await expect(verifyTwilioCode(PHONE, "654321", SID)).rejects.toBe(error);
    expect(sdk.send).toHaveBeenCalledTimes(1);
    expect(sdk.check).toHaveBeenCalledTimes(1);
    for (const method of ["log", "info", "warn", "error"]) expect(console[method]).not.toHaveBeenCalled();
  });
});

const ambiguousErrors = [
  ["request timeout", { code: "ETIMEDOUT" }],
  ["socket timeout", { code: "ESOCKETTIMEDOUT" }],
  ["Axios timeout", { code: "ECONNABORTED" }],
  ["connection reset", { code: "ECONNRESET" }],
  ["broken pipe", { code: "EPIPE" }],
  ["undici socket", { code: "UND_ERR_SOCKET" }],
  ["undici headers timeout", { code: "UND_ERR_HEADERS_TIMEOUT" }],
  ["undici body timeout", { code: "UND_ERR_BODY_TIMEOUT" }],
  ["network failure", { code: "ERR_NETWORK" }],
  ["aborted request", { name: "AbortError", code: "ABORT_ERR" }],
  ["cancelled request", { code: "ERR_CANCELED" }],
  ["timeout message", { message: "request timed out" }],
  ["socket message", { message: "socket hang up" }],
  ["HTTP 408", { status: 408 }],
  ["HTTP 500", { status: 500, code: 20500 }],
  ["HTTP 503", { statusCode: 503 }],
  ["HTTP 599", { response: { status: 599 } }],
  ["nested 5xx", { cause: { response: { status: "502" } } }],
  ["wrapped reset", { code: "WRAPPED_ERROR", cause: { code: "ECONNRESET" } }],
  ["wrapped timeout", { code: "WRAPPED_ERROR", response: { code: "ECONNABORTED" } }],
  ["DNS with later reset", { code: "ENOTFOUND", cause: { code: "ECONNRESET" } }],
  ["DNS with server response", { status: 503, cause: { code: "ENOTFOUND" } }],
  ["unrecognized failure", new Error("unrecognized provider failure")],
  ["empty failure", undefined],
];

describe.each([
  ["send", "classifyTwilioSendError", "OTP_SEND_PENDING"],
  ["check", "classifyTwilioVerifyError", "OTP_VERIFY_TEMPORARY_FAILURE"],
])("%s error classification", (_operation, exportName, unknownCode) => {
  it.each(ambiguousErrors)("treats %s as unknown and never safe to retry", async (_name, error) => {
    const classify = (await loadAdapter())[exportName];
    expect(classify(error)).toMatchObject({
      errorCode: unknownCode, errorCategory: "UNKNOWN_PROVIDER_RESULT", retryable: false, unknown: true,
    });
  });

  it.each(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"])(
    "identifies known pre-request %s as retryable, including a wrapped cause",
    async (code) => {
      const classify = (await loadAdapter())[exportName];
      for (const error of [{ code }, { code: "ERR_NETWORK", cause: { code } }]) {
        expect(classify(error)).toMatchObject({
          errorCategory: "NETWORK_BEFORE_REQUEST", retryable: true, unknown: false, providerErrorCode: code,
        });
      }
    },
  );

  it("keeps configuration failure distinct from authentication", async () => {
    const classify = (await loadAdapter())[exportName];
    expect(classify({ code: "TWILIO_VERIFY_NOT_CONFIGURED" })).toMatchObject({
      errorCode: "OTP_SERVICE_NOT_CONFIGURED", errorCategory: "CONFIGURATION", retryable: false, unknown: false,
    });
    for (const status of [401, 403]) {
      expect(classify({ status, code: 20003 })).toMatchObject({
        errorCategory: "AUTH", retryable: false, unknown: false, providerHttpStatus: status, providerErrorCode: 20003,
      });
    }
  });

  it("identifies provider throttling without automatic retry", async () => {
    const classify = (await loadAdapter())[exportName];
    expect(classify({ status: 429, code: 20429 })).toMatchObject({
      errorCode: exportName === "classifyTwilioSendError" ? "OTP_RATE_LIMITED" : "OTP_VERIFY_RATE_LIMITED",
      errorCategory: "PROVIDER_RATE_LIMIT", retryable: false, unknown: false,
    });
  });

  it("keeps definitive validation and expired/not-found responses invalid, never approved", async () => {
    const classify = (await loadAdapter())[exportName];
    for (const status of [400, 404]) {
      expect(classify({ status, code: 20404, message: "verification expired or already consumed" })).toMatchObject({
        errorCode: exportName === "classifyTwilioSendError" ? "INVALID_PHONE" : "INVALID_OTP",
        errorCategory: "PROVIDER_VALIDATION", retryable: false, unknown: false,
      });
    }
  });

  it("keeps other explicit rejection responses non-retryable", async () => {
    const classify = (await loadAdapter())[exportName];
    expect(classify({ status: 422 })).toMatchObject({ retryable: false, unknown: false });
  });

  it("handles cyclic error wrappers without exposing request/source data", async () => {
    const classify = (await loadAdapter())[exportName];
    const error = { code: "private-code", message: `private-provider-body ${PHONE}`, sourceHash: "private-source", body: { token: TOKEN, sid: SID } };
    error.cause = { cause: error, response: { code: "ECONNRESET" } };
    const result = classify(error);
    expect(result).toMatchObject({ unknown: true, retryable: false, providerErrorCode: "ECONNRESET" });
    expect(inspect(result)).not.toMatch(/private-|\+972|VE012345/);
    for (const method of ["log", "info", "warn", "error"]) expect(console[method]).not.toHaveBeenCalled();
  });

  it.each(["private-code", "+972500000001", "198.51.100.1", { token: TOKEN }])(
    "does not copy unrecognized provider error codes into diagnostics: %j",
    async (code) => {
      const classify = (await loadAdapter())[exportName];
      const result = classify({ code, message: "private-provider-body", source: "private-source" });
      expect(result.providerErrorCode).toBeUndefined();
      expect(inspect(result)).not.toMatch(/private-|\+972|198\.51/);
    },
  );
});

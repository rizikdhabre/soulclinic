import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeOtpClientFlow, createOtpApiClient, sendOtpClientFlow, startOtpClientFlow } from "@/lib/otp/client";

const challenge = {
  challengeToken: "private-challenge", provider: "twilio",
  expiresAt: "2026-09-11T12:10:00.000Z",
  correlationId: "00000000-0000-4000-8000-000000000001",
  serverTime: "2026-09-11T12:00:00.000Z", retryAt: "2026-09-11T12:01:00.000Z", retryAfterSeconds: 60,
};
const sent = { provider: "twilio", status: "pending", retryAfterSeconds: 60 };
function createApi() {
  return {
    challenge: vi.fn().mockResolvedValue({ ...challenge }),
    send: vi.fn().mockResolvedValue(sent),
    complete: vi.fn().mockResolvedValue({ success: true, purpose: "booking", verificationToken: "private-grant" }),
  };
}
function failure(code, recoveryReceipt) {
  return Object.assign(new Error("private provider details"), {
    response: { data: { error: code, ...(recoveryReceipt ? { recoveryReceipt } : {}) } },
  });
}
beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("Twilio client contract", () => {
  it("preserves the original Axios endpoints and adds the Firebase coordination endpoints", async () => {
    const http = { post: vi.fn().mockResolvedValue({ data: { ok: true } }) };
    const api = createOtpApiClient(http);
    expect(Object.keys(api).sort()).toEqual(["challenge", "complete", "fallback", "firebaseSend", "send"]);
    for (const [method, payload] of [
      ["challenge", { phone: "+972521234567", purpose: "login" }],
      ["send", { challengeToken: "private-challenge" }],
      ["complete", { challengeToken: "private-challenge", purpose: "login", code: "123456" }],
    ]) {
      await expect(api[method](payload)).resolves.toEqual({ ok: true });
      expect(http.post).toHaveBeenLastCalledWith("/api/otp/" + method, payload);
    }
  });

  it("publishes the prepared flow before sending without treating its provider as proof of SMS", async () => {
    const api = createApi();
    let prepared;
    api.send.mockImplementation(async (payload) => {
      expect(prepared).toMatchObject({ ...challenge, purpose: "booking", sendStatus: "prepared" });
      expect(payload).toEqual({ challengeToken: "private-challenge" });
      return sent;
    });
    const flow = await startOtpClientFlow({ phone: "+972521234567", purpose: "booking", api, onPrepared: (value) => { prepared = value; } });
    expect(flow).toBe(prepared);
    expect(flow.sendStatus).toBe("sent");
    expect(api.challenge).toHaveBeenCalledExactlyOnceWith({ phone: "+972521234567", purpose: "booking" });
    expect(api.send).toHaveBeenCalledTimes(1);
    expect(api.complete).not.toHaveBeenCalled();
  });

  it.each(["OTP_SEND_PENDING", "OTP_SEND_TEMPORARY_FAILURE", "OTP_PERSISTENCE_FAILED"])("retains a %s send receipt for manual retry of the same challenge", async (code) => {
    const api = createApi();
    const error = failure(code, "private-send-receipt");
    api.send.mockRejectedValueOnce(error);
    let flow;
    await expect(startOtpClientFlow({ phone: "+972521234567", purpose: "booking", api, onPrepared: (value) => { flow = value; } })).rejects.toBe(error);
    expect(flow).toMatchObject({ challengeToken: "private-challenge", recoveryReceipt: "private-send-receipt", sendStatus: "prepared" });
    expect(api.send).toHaveBeenCalledTimes(1);
    await sendOtpClientFlow({ flow, api });
    expect(api.send).toHaveBeenLastCalledWith({ challengeToken: "private-challenge", recoveryReceipt: "private-send-receipt" });
    expect(api.challenge).toHaveBeenCalledTimes(1);
    expect(flow.recoveryReceipt).toBeUndefined();
  });

  it("does not automatically retry an unknown send outcome", async () => {
    const api = createApi();
    api.send.mockRejectedValue(new Error("network disconnected"));
    await expect(startOtpClientFlow({ phone: "+972521234567", purpose: "login", api })).rejects.toThrow("network disconnected");
    expect(api.challenge).toHaveBeenCalledTimes(1);
    expect(api.send).toHaveBeenCalledTimes(1);
  });

  it.each(["OTP_SEND_FAILED", "OTP_CHALLENGE_EXPIRED"])("marks %s terminal only when the server explicitly permits restarting without a receipt", async (code) => {
    const api = createApi();
    const error = failure(code);
    error.response.data.restartAllowed = true;
    api.send.mockRejectedValueOnce(error);
    let flow;
    await expect(startOtpClientFlow({ phone: "+972521234567", purpose: "booking", api, onPrepared: (value) => { flow = value; } })).rejects.toBe(error);
    expect(flow.sendStatus).toBe("failed");
    expect(api.challenge).toHaveBeenCalledTimes(1);
    expect(api.send).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, false, "true", 1])("keeps a terminal-looking error prepared when restartAllowed is %s", async (restartAllowed) => {
    const api = createApi();
    const error = failure("OTP_CHALLENGE_EXPIRED");
    error.response.data.restartAllowed = restartAllowed;
    api.send.mockRejectedValueOnce(error);
    let flow;
    await startOtpClientFlow({ phone: "+972521234567", purpose: "booking", api, onPrepared: (value) => { flow = value; } }).catch(() => {});
    expect(flow.sendStatus).toBe("prepared");
    expect(api.send).toHaveBeenCalledTimes(1);
  });

  it("keeps a newly issued recovery receipt even if its response also allows restarting", async () => {
    const api = createApi();
    const error = failure("OTP_CHALLENGE_EXPIRED", "private-send-receipt");
    error.response.data.restartAllowed = true;
    const flow = { ...challenge, purpose: "booking", sendStatus: "prepared" };
    api.send.mockRejectedValueOnce(error);
    await expect(sendOtpClientFlow({ flow, api })).rejects.toBe(error);
    expect(flow).toMatchObject({ sendStatus: "prepared", recoveryReceipt: "private-send-receipt" });
    await sendOtpClientFlow({ flow, api });
    expect(api.send).toHaveBeenLastCalledWith({ challengeToken: "private-challenge", recoveryReceipt: "private-send-receipt" });
    expect(api.challenge).not.toHaveBeenCalled();
  });

  it("permits restart after replaying a retained receipt when the server now declares receipt-free terminal expiry", async () => {
    const api = createApi();
    const error = failure("OTP_CHALLENGE_EXPIRED");
    error.response.data.restartAllowed = true;
    const flow = { ...challenge, purpose: "booking", sendStatus: "prepared", recoveryReceipt: "private-old-receipt", recoveryOperation: "send" };
    api.send.mockRejectedValueOnce(error);
    await expect(sendOtpClientFlow({ flow, api })).rejects.toBe(error);
    expect(api.send).toHaveBeenCalledExactlyOnceWith({ challengeToken: "private-challenge", recoveryReceipt: "private-old-receipt" });
    expect(flow.sendStatus).toBe("failed");
    expect(api.challenge).not.toHaveBeenCalled();
  });

  it("does not mark a cancelled send terminal when its restart response arrives late", async () => {
    const api = createApi();
    const error = failure("OTP_CHALLENGE_EXPIRED");
    error.response.data.restartAllowed = true;
    let current = true;
    api.send.mockImplementation(async () => { current = false; throw error; });
    const flow = { ...challenge, purpose: "booking", sendStatus: "prepared" };
    await expect(sendOtpClientFlow({ flow, api, isCurrentAttempt: () => current })).rejects.toBe(error);
    expect(flow.sendStatus).toBe("prepared");
  });

  it("rejects a malformed send success instead of claiming an SMS was sent", async () => {
    const api = createApi();
    api.send.mockResolvedValue({ provider: "twilio" });
    let flow;
    await expect(startOtpClientFlow({ phone: "+972521234567", purpose: "login", api, onPrepared: (value) => { flow = value; } })).rejects.toMatchObject({ code: "OTP_SEND_PENDING" });
    expect(flow.sendStatus).toBe("prepared");
  });

  it("records a stale reservation but never publishes its token or sends it", async () => {
    const api = createApi();
    let current = true;
    api.challenge.mockImplementation(async () => { current = false; return challenge; });
    const onChallenge = vi.fn();
    const onPrepared = vi.fn();
    await expect(startOtpClientFlow({ phone: "+972521234567", purpose: "booking", api, onChallenge, onPrepared, isCurrentAttempt: () => current })).rejects.toMatchObject({ code: "OTP_FLOW_CANCELLED" });
    expect(onChallenge).toHaveBeenCalledWith(expect.objectContaining({ retryAfterSeconds: 60 }));
    expect(onPrepared).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
  });

  it("does not send after onPrepared cancels the attempt", async () => {
    const api = createApi();
    let current = true;
    await expect(startOtpClientFlow({ phone: "+972521234567", purpose: "booking", api, onPrepared: () => { current = false; }, isCurrentAttempt: () => current })).rejects.toMatchObject({ code: "OTP_FLOW_CANCELLED" });
    expect(api.send).not.toHaveBeenCalled();
  });

  it("rejects unsupported providers before sending or completing", async () => {
    const api = createApi();
    api.challenge.mockResolvedValue({ ...challenge, provider: "unknown" });
    await expect(startOtpClientFlow({ phone: "+972521234567", purpose: "booking", api })).rejects.toMatchObject({ code: "OTP_PROVIDER_UNSUPPORTED" });
    await expect(completeOtpClientFlow({ flow: { ...challenge, provider: "unknown" }, code: "123456", api })).rejects.toMatchObject({ code: "OTP_PROVIDER_UNSUPPORTED" });
    expect(api.send).not.toHaveBeenCalled();
    expect(api.complete).not.toHaveBeenCalled();
  });
});

describe("completion and recovery privacy", () => {
  it.each(["login", "booking"])("submits the flow's %s purpose without provider or phone", async (purpose) => {
    const api = createApi();
    const result = { success: true, purpose, ...(purpose === "booking" ? { verificationToken: "private-grant", profileStatus: "complete" } : {}) };
    api.complete.mockResolvedValue(result);
    const flow = await startOtpClientFlow({ phone: "+972521234567", purpose, api });
    await expect(completeOtpClientFlow({ flow, code: "123456", api, purpose: "untrusted" })).resolves.toEqual(result);
    expect(api.complete).toHaveBeenCalledExactlyOnceWith({ challengeToken: "private-challenge", purpose, code: "123456" });
  });

  it("retains a completion receipt across a receipt-free failure and clears it on success", async () => {
    const api = createApi();
    const flow = await startOtpClientFlow({ phone: "+972521234567", purpose: "booking", api });
    api.complete.mockRejectedValueOnce(failure("OTP_PERSISTENCE_FAILED", "private-verify-receipt")).mockRejectedValueOnce(failure("OTP_VERIFY_TEMPORARY_FAILURE"));
    await completeOtpClientFlow({ flow, code: "123456", api }).catch(() => {});
    await completeOtpClientFlow({ flow, code: "123456", api }).catch(() => {});
    expect(flow.recoveryReceipt).toBe("private-verify-receipt");
    await completeOtpClientFlow({ flow, code: "123456", api });
    expect(api.complete).toHaveBeenLastCalledWith({ challengeToken: "private-challenge", purpose: "booking", code: "123456", recoveryReceipt: "private-verify-receipt" });
    expect(flow.recoveryReceipt).toBeUndefined();
    expect(api.send).toHaveBeenCalledTimes(1);
  });

  it("never crosses send and completion recovery receipts", async () => {
    const api = createApi();
    api.send.mockRejectedValueOnce(failure("OTP_PERSISTENCE_FAILED", "private-send-receipt"));
    let flow;
    await startOtpClientFlow({ phone: "+972521234567", purpose: "booking", api, onPrepared: (value) => { flow = value; } }).catch(() => {});
    api.complete.mockRejectedValueOnce(failure("OTP_VERIFY_TEMPORARY_FAILURE", "private-completion-receipt"));
    await completeOtpClientFlow({ flow, code: "123456", api }).catch(() => {});
    expect(api.complete).toHaveBeenCalledWith({ challengeToken: "private-challenge", purpose: "booking", code: "123456" });
    await sendOtpClientFlow({ flow, api });
    expect(api.send).toHaveBeenLastCalledWith({ challengeToken: "private-challenge" });
  });

  it("keeps receipts, codes, tokens, phones and raw errors out of logs and storage", async () => {
    const storage = { setItem: vi.fn() };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("sessionStorage", storage);
    try {
      const api = createApi();
      api.send.mockRejectedValueOnce(failure("OTP_PERSISTENCE_FAILED", "private-send-receipt"));
      let flow;
      await startOtpClientFlow({ phone: "+972521234567", purpose: "booking", api, onPrepared: (value) => { flow = value; } }).catch(() => {});
      await sendOtpClientFlow({ flow, api });
      api.complete.mockRejectedValueOnce(failure("OTP_COMPLETION_IN_PROGRESS", "private-complete-receipt"));
      await completeOtpClientFlow({ flow, code: "654321", api }).catch(() => {});
      await completeOtpClientFlow({ flow, code: "654321", api });
      const logs = JSON.stringify(console.info.mock.calls);
      for (const secret of ["private-", "654321", "+972521234567"]) expect(logs).not.toContain(secret);
      expect(storage.setItem).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

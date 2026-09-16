import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPhoneOtpController, usePhoneOtp } from "@/hooks/usePhoneOtp";
import fs from "node:fs";
import { parse } from "@babel/parser";
import React, { StrictMode, act, useEffect } from "react";
import { createRoot } from "react-dom/client";

const phone = "+972521234567";
const report = { code: "auth/network-request-failed", stage: "send", provenance: "firebase_sdk" };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  const flowRef = { current: null };
  const firebaseClient = { send: vi.fn().mockResolvedValue({ confirmation: true }), confirm: vi.fn().mockResolvedValue("private-id-token"), clearConfirmation: vi.fn(), dispose: vi.fn() };
  const api = {
    challenge: vi.fn(async ({ phone, purpose }) => ({ challengeToken: "private-challenge", phone, purpose, provider: "firebase", providerPolicy: "firebase_first", retryAfterSeconds: 60 })),
    firebaseSend: vi.fn(async ({ operation }) => ({ provider: "firebase", status: operation === "reserve" ? "reserved" : "pending", firebaseSendId: "private-send", phone })),
    fallback: vi.fn().mockResolvedValue({ provider: "twilio", status: "pending" }),
    send: vi.fn().mockResolvedValue({ provider: "twilio", status: "pending" }),
    complete: vi.fn().mockResolvedValue({ success: true, purpose: "booking" }),
  };
  const controller = createPhoneOtpController({ purpose: "booking", api, firebaseClient, flowRef });
  return { api, controller, firebaseClient, flowRef };
}
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, "info").mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Firebase-first controller", () => {
  it("technical confirmation fallback asks for a new Twilio code and never submits the Firebase code to Twilio", async () => {
    const h = harness();
    await h.controller.start(phone);
    h.firebaseClient.confirm.mockRejectedValue(Object.assign(new Error("private"), { firebaseFailure: { code: "auth/network-request-failed", stage: "confirm", provenance: "firebase_sdk" } }));
    await expect(h.controller.verify("654321")).resolves.toBeUndefined();
    expect(h.controller.getSnapshot()).toMatchObject({ provider: "twilio", phase: "code", smsSent: true, error: null });
    expect(h.api.fallback).toHaveBeenCalledTimes(1);
    expect(h.api.complete).not.toHaveBeenCalled();
    expect(h.firebaseClient.clearConfirmation).toHaveBeenCalledTimes(1);
    await h.controller.verify("987654");
    expect(h.api.complete).toHaveBeenCalledWith(expect.objectContaining({ code: "987654" }));
    expect(h.firebaseClient.confirm).toHaveBeenCalledTimes(1);
    h.controller.dispose();
  });
  it("keeps a provider-accepted Firebase code usable when acknowledgement cannot persist", async () => {
    const h = harness();
    h.api.firebaseSend.mockImplementation(async ({ operation }) => {
      if (operation === "accepted") throw Object.assign(new Error("acknowledgement unavailable"), { code: "OTP_PERSISTENCE_FAILED" });
      return { provider: "firebase", status: "reserved", firebaseSendId: "private-send", phone };
    });
    try {
      await expect(h.controller.start(phone)).rejects.toMatchObject({ code: "OTP_PERSISTENCE_FAILED" });
      expect(h.controller.getSnapshot()).toMatchObject({ phase: "code", smsSent: true, canRetrySend: true });
      await expect(h.controller.verify("654321")).resolves.toMatchObject({ success: true, purpose: "booking" });
      expect(h.firebaseClient.send).toHaveBeenCalledTimes(1);
      expect(h.firebaseClient.confirm).toHaveBeenCalledTimes(1);
      expect(h.api.firebaseSend).toHaveBeenCalledTimes(2);
      expect(h.api.complete).toHaveBeenCalledWith({ challengeToken: "private-challenge", purpose: "booking", idToken: "private-id-token" });
      expect(h.api.fallback).not.toHaveBeenCalled();
    } finally { h.controller.dispose(); }
  });

  it("shows Arabic fallback progress without a generic error during the automatic transition", async () => {
    const h = harness();
    h.firebaseClient.send.mockRejectedValue(Object.assign(new Error("private"), { firebaseFailure: report }));
    const pending = deferred();
    h.api.fallback.mockReturnValue(pending.promise);
    const starting = h.controller.start(phone).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getSnapshot()).toMatchObject({ loading: true, error: null, statusMessage: "جارٍ محاولة إرسال الرمز عبر الخدمة البديلة…" });
    pending.resolve({ provider: "twilio", status: "pending" });
    await starting;
    expect(h.controller.getSnapshot()).toMatchObject({ provider: "twilio", smsSent: true, statusMessage: "", error: null });
    h.controller.dispose();
  });
  it("retains acknowledgement recovery during cooldown, then uses a fresh challenge only for explicit resend", async () => {
    const h = harness();
    h.api.firebaseSend.mockResolvedValueOnce({ provider: "firebase", status: "reserved", firebaseSendId: "private-send", phone }).mockRejectedValueOnce(new Error("ack lost"));
    await h.controller.start(phone).catch(() => {});
    expect(h.controller.getSnapshot()).toMatchObject({ canRetrySend: true, cooldownSeconds: 60 });
    await h.controller.resend();
    expect(h.firebaseClient.send).toHaveBeenCalledTimes(1);
    expect(h.api.challenge).toHaveBeenCalledTimes(1);
    await expect(h.controller.resend()).resolves.toMatchObject({ started: false, reason: "cooldown" });
    await vi.advanceTimersByTimeAsync(60_000);
    h.api.challenge.mockResolvedValueOnce({ challengeToken: "private-new", provider: "twilio", providerPolicy: "twilio_only", phone });
    await h.controller.resend();
    expect(h.api.challenge).toHaveBeenCalledTimes(2);
    expect(h.api.send).toHaveBeenCalledExactlyOnceWith({ challengeToken: "private-new" });
    expect(h.firebaseClient.send).toHaveBeenCalledTimes(1);
    h.controller.dispose();
  });
  it.each(["accepted", "fallback"])("starts a fresh challenge only after explicit restart permission for expired %s recovery", async (operation) => {
    const h = harness();
    const lostAcknowledgement = new Error("acknowledgement lost");
    const expired = Object.assign(new Error("expired"), { response: { data: { error: "OTP_CHALLENGE_EXPIRED" } } });
    const restartable = Object.assign(new Error("expired and restartable"), { response: { data: { error: "OTP_CHALLENGE_EXPIRED", restartAllowed: true } } });
    const replay = operation === "accepted" ? h.api.firebaseSend : h.api.fallback;
    h.api.challenge.mockResolvedValueOnce({ challengeToken: "private-expired", phone, purpose: "booking", provider: "firebase", providerPolicy: "firebase_first", retryAfterSeconds: 60, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    if (operation === "accepted") {
      h.api.firebaseSend.mockResolvedValueOnce({ provider: "firebase", status: "reserved", firebaseSendId: "private-send", phone }).mockRejectedValueOnce(lostAcknowledgement);
    } else {
      h.firebaseClient.send.mockRejectedValueOnce(Object.assign(new Error("send rejected"), { firebaseFailure: report }));
      h.api.fallback.mockRejectedValueOnce(lostAcknowledgement);
    }

    try {
      await expect(h.controller.start(phone)).rejects.toBe(lostAcknowledgement);
      const oldFlow = h.flowRef.current;
      expect(h.controller.getSnapshot()).toMatchObject({ canRetrySend: true, cooldownSeconds: 60, smsSent: operation === "accepted" });
      await vi.advanceTimersByTimeAsync(600_001);

      replay.mockRejectedValueOnce(expired);
      await expect(h.controller.resend()).rejects.toBe(expired);
      expect(h.flowRef.current).toBe(oldFlow);
      expect(oldFlow.sendStatus).toBe("prepared");
      expect(h.controller.getSnapshot()).toMatchObject({ canRetrySend: true, cooldownSeconds: 0, error: { code: "OTP_CHALLENGE_EXPIRED" } });
      expect(h.api.challenge).toHaveBeenCalledTimes(1);
      expect(h.firebaseClient.send).toHaveBeenCalledTimes(1);

      replay.mockRejectedValueOnce(restartable);
      await expect(h.controller.resend()).rejects.toBe(restartable);
      expect(h.flowRef.current).toBe(oldFlow);
      expect(oldFlow.sendStatus).toBe("failed");
      expect(h.controller.getSnapshot()).toMatchObject({ canRetrySend: false, loading: false, cooldownSeconds: 0 });
      expect(replay).toHaveBeenLastCalledWith({ challengeToken: "private-expired", firebaseSendId: "private-send", ...(operation === "accepted" ? { operation: "accepted" } : { failure: report }) });
      expect(h.api.challenge).toHaveBeenCalledTimes(1);
      expect(h.firebaseClient.send).toHaveBeenCalledTimes(1);

      h.api.challenge.mockResolvedValueOnce({ challengeToken: "private-new", phone, purpose: "booking", provider: "firebase", providerPolicy: "firebase_first", retryAfterSeconds: 60 });
      h.api.firebaseSend.mockImplementation(async ({ operation }) => ({ provider: "firebase", status: operation === "reserve" ? "reserved" : "pending", firebaseSendId: "private-new-send", phone }));
      await expect(h.controller.resend()).resolves.toEqual({ started: true, provider: "firebase" });
      expect(h.flowRef.current).not.toBe(oldFlow);
      expect(h.flowRef.current).toMatchObject({ challengeToken: "private-new", firebaseSendId: "private-new-send", sendStatus: "sent" });
      expect(h.controller.getSnapshot()).toMatchObject({ provider: "firebase", smsSent: true, canRetrySend: false, cooldownSeconds: 60, error: null });
      expect(h.api.challenge).toHaveBeenCalledTimes(2);
      expect(h.firebaseClient.send).toHaveBeenCalledTimes(2);
      expect(h.api.firebaseSend.mock.calls.slice(-2).map(([payload]) => payload)).toEqual([
        { challengeToken: "private-new", operation: "reserve" },
        { challengeToken: "private-new", operation: "accepted", firebaseSendId: "private-new-send" },
      ]);
      expect(h.api.fallback).toHaveBeenCalledTimes(operation === "fallback" ? 3 : 0);
      expect(h.api.send).not.toHaveBeenCalled();
      expect(h.api.complete).not.toHaveBeenCalled();
    } finally {
      h.controller.dispose();
    }
  });
  it("preserves equivalent phone formats but discards cached proof when normalized phone changes", async () => {
    const h = harness();
    await h.controller.start(phone);
    h.api.complete.mockRejectedValue(new Error("complete unavailable"));
    await h.controller.verify("123456").catch(() => {});
    const old = h.flowRef.current;
    expect(old.idToken).toBe("private-id-token");
    expect(h.controller.setPhone("052-123-4567")).toBe(false);
    expect(h.flowRef.current).toBe(old);
    expect(h.controller.setPhone("0521234568")).toBe(true);
    expect(h.flowRef.current).toBeNull();
    expect(old.idToken).toBeUndefined();
    expect(old.confirmationResult).toBeUndefined();
    expect(h.firebaseClient.clearConfirmation).toHaveBeenCalledExactlyOnceWith({ confirmation: true });
    h.controller.dispose();
  });
  it("keeps a hanging send pending beyond the watchdog without fallback or a second send", async () => {
    const h = harness();
    const pending = deferred();
    h.firebaseClient.send.mockReturnValue(pending.promise);
    const starting = h.controller.start(phone).catch((error) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.controller.getSnapshot()).toMatchObject({ loading: true, error: null, smsSent: false });
    expect(h.controller.getSnapshot().statusMessage).toBeTruthy();
    await h.controller.resend();
    expect(h.firebaseClient.send).toHaveBeenCalledTimes(1);
    expect(h.api.fallback).not.toHaveBeenCalled();
    h.controller.setPhone("0521234568");
    pending.resolve({ stale: true });
    await expect(starting).resolves.toMatchObject({ started: false, reason: "cancelled" });
    expect(h.controller.getSnapshot()).toMatchObject({ phase: "idle", smsSent: false, provider: null });
    h.controller.dispose();
  });
  it.each([
    ["auth/invalid-verification-code", "INVALID_OTP"],
    ["auth/code-expired", "OTP_VERIFICATION_EXPIRED"],
    ["auth/too-many-requests", "OTP_VERIFY_RATE_LIMITED"],
  ])("projects %s safely as %s during confirmation", async (code, expected) => {
    const h = harness();
    await h.controller.start(phone);
    h.firebaseClient.confirm.mockRejectedValue(Object.assign(new Error("private detail"), { code, firebaseFailure: { code, stage: "confirm", provenance: "firebase_sdk" } }));
    await h.controller.verify("123456").catch(() => {});
    expect(h.controller.getSnapshot().error).toMatchObject({ code: expected });
    expect(JSON.stringify(h.controller.getSnapshot())).not.toContain("private");
    expect(h.api.fallback).not.toHaveBeenCalled();
    h.controller.dispose();
  });
  it("disposes the used adapter once without initializing Firebase for an unused controller", async () => {
    const h = harness();
    await h.controller.start(phone);
    h.controller.dispose();
    h.controller.dispose();
    expect(h.firebaseClient.dispose).toHaveBeenCalledTimes(1);
    const loadFirebaseClient = vi.fn();
    const unused = createPhoneOtpController({ purpose: "login", loadFirebaseClient });
    unused.activate(); unused.dispose(); unused.activate(); unused.dispose();
    expect(loadFirebaseClient).not.toHaveBeenCalled();
  });
  it("discards a late confirmation token after phone change", async () => {
    const h = harness();
    await h.controller.start(phone);
    const old = h.flowRef.current;
    const pending = deferred();
    h.firebaseClient.confirm.mockReturnValue(pending.promise);
    const completion = h.controller.verify("654321").catch((error) => error);
    h.controller.setPhone("0521234568");
    pending.resolve("private-id-token");
    expect(await completion).toMatchObject({ code: "OTP_FLOW_CANCELLED" });
    expect(old.idToken).toBeUndefined();
    expect(h.api.complete).not.toHaveBeenCalled();
    h.controller.dispose();
  });
  it("keeps source and global limits distinct after a failed fallback replay", async () => {
    const h = harness();
    h.firebaseClient.send.mockRejectedValue(Object.assign(new Error("private"), { firebaseFailure: report }));
    h.api.fallback.mockRejectedValue(Object.assign(new Error("private"), { response: { data: { error: "OTP_SEND_SOURCE_RATE_LIMITED", retryAfterSeconds: 90 } } }));
    await h.controller.start(phone).catch(() => {});
    expect(h.controller.getSnapshot().error.code).toBe("OTP_SEND_SOURCE_RATE_LIMITED");
    h.controller.setPhone("0521234568");
    expect(h.controller.getSnapshot().cooldownSeconds).toBe(90);
    expect(h.controller.getSnapshot().error.code).toBe("OTP_SEND_SOURCE_RATE_LIMITED");
    expect(h.firebaseClient.send).toHaveBeenCalledTimes(1);
    h.controller.dispose();
  });
  it.each([
    ["client/configuration", "OTP_SERVICE_NOT_CONFIGURED"],
    ["client/container-unavailable", "OTP_SEND_TEMPORARY_FAILURE"],
    ["auth/quota-exceeded", "OTP_PROVIDER_RATE_LIMITED"],
    ["auth/invalid-phone-number", "INVALID_PHONE"],
    ["auth/timeout", "OTP_SEND_TEMPORARY_FAILURE"],
    ["constructor", "OTP_REQUEST_FAILED"],
    ["__proto__", "OTP_REQUEST_FAILED"],
  ])("projects send failure %s to bounded public code %s", async (code, expected) => {
    const h = harness();
    h.api.firebaseSend.mockImplementation(async ({ operation }) => ({ provider: "firebase", status: operation === "reserve" ? "reserved" : "failed", firebaseSendId: "private-send", phone }));
    h.firebaseClient.send.mockRejectedValue(Object.assign(new Error("private"), { code, firebaseFailure: { code, stage: "initialize", provenance: "client" } }));
    await h.controller.start(phone).catch(() => {});
    expect(h.controller.getSnapshot().error.code).toBe(expected);
    expect(h.api.fallback).not.toHaveBeenCalled();
    h.controller.dispose();
  });
});

it("uses distinct stable login and booking host IDs across real StrictMode rerenders", async () => {
  const noop = () => {};
  const document = { nodeType: 9, activeElement: null, addEventListener: noop, removeEventListener: noop, defaultView: globalThis };
  const container = { nodeType: 1, tagName: "DIV", nodeName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml", ownerDocument: document, addEventListener: noop, removeEventListener: noop };
  document.documentElement = document.body = container;
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("HTMLIFrameElement", class {});
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const observed = [];
  function Probe() {
    const login = usePhoneOtp({ purpose: "login" });
    const booking = usePhoneOtp({ purpose: "booking" });
    useEffect(() => { observed.push([login.recaptchaContainerId, booking.recaptchaContainerId]); });
    return null;
  }
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(StrictMode, null, React.createElement(Probe))));
    await act(async () => root.render(React.createElement(StrictMode, null, React.createElement(Probe))));
    expect(observed.length).toBeGreaterThanOrEqual(3);
    const [login, booking] = observed[0];
    expect(login).toMatch(/^otp-login-/);
    expect(booking).toMatch(/^otp-booking-/);
    expect(login).not.toBe(booking);
    for (const ids of observed) expect(ids).toEqual([login, booking]);
  } finally { await act(async () => root.unmount()); }
});

function walk(node, visit, parents = []) {
  if (!node || typeof node !== "object") return;
  if (node.type) visit(node, parents);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit, [...parents, node]));
    else if (value && typeof value === "object") walk(value, visit, [...parents, node]);
  }
}

describe("OTP form and logout integration", () => {
  it.each(["src/components/ui/LoginPage.jsx", "src/components/ui/AppointmentForm.jsx"])("keeps one unconditional reCAPTCHA host and live status in %s", (file) => {
    const source = fs.readFileSync(file, "utf8");
    const ast = parse(source, { sourceType: "module", plugins: ["jsx"] });
    const hosts = [];
    let status = false;
    walk(ast, (node, parents) => {
      if (node.type === "JSXAttribute" && node.name.name === "id" && source.slice(node.start, node.end).includes("otpFlow.recaptchaContainerId")) hosts.push(parents);
      if (node.type === "JSXAttribute" && node.name.name === "role" && node.value?.value === "status") status = true;
    });
    expect(hosts).toHaveLength(1);
    expect(hosts[0].some((node) => ["ConditionalExpression", "LogicalExpression"].includes(node.type))).toBe(false);
    expect(source).toContain("otpFlow.statusMessage");
    expect(status).toBe(true);
    expect(source).toContain('case "OTP_PROVIDER_RATE_LIMITED"');
  });

  it.each(["reject", "hang"])("finishes application logout before Firebase cleanup can %s", async (cleanupMode) => {
    const source = fs.readFileSync("src/app/userAppointments/UserAppointmentsClient.js", "utf8");
    const ast = parse(source, { sourceType: "module", plugins: ["jsx"] });
    let handler;
    walk(ast, (node) => { if (node.type === "FunctionDeclaration" && node.id?.name === "handleLogout") handler = node; });
    let body = source.slice(handler.body.start + 1, handler.body.end - 1);
    const imports = [];
    walk(handler, (node) => { if (node.type === "CallExpression" && node.callee.type === "Import") imports.push(node); });
    expect(imports).toHaveLength(1);
    for (const node of imports.reverse()) {
      const from = node.start - handler.body.start - 1;
      const to = node.end - handler.body.start - 1;
      body = body.slice(0, from) + "loadFirebaseClient()" + body.slice(to);
    }
    const events = [];
    const appLogout = deferred();
    const cleanup = vi.fn(() => { events.push("firebase-clear"); return cleanupMode === "reject" ? Promise.reject(new Error("private")) : new Promise(() => {}); });
    const loadFirebaseClient = vi.fn(async () => ({ clearFirebaseBrowserSession: cleanup }));
    const http = { post: vi.fn(() => appLogout.promise) };
    const router = { replace: vi.fn(() => events.push("navigate")) };
    const setError = vi.fn();
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const logout = new AsyncFunction("axios", "router", "loggingOut", "setLoggingOut", "setError", "loadFirebaseClient", body);
    const result = logout(http, router, false, vi.fn(), setError, loadFirebaseClient);
    expect(loadFirebaseClient).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    appLogout.resolve({ success: true });
    await result;
    await vi.advanceTimersByTimeAsync(0);
    expect(http.post).toHaveBeenCalledExactlyOnceWith("/api/customer/logout");
    expect(router.replace).toHaveBeenCalledExactlyOnceWith("/login");
    expect(events).toEqual(["navigate", "firebase-clear"]);
    expect(setError.mock.calls).toEqual([[""]]);
  });
});

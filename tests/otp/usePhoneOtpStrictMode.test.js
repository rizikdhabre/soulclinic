import React, { StrictMode, act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({
  api: {},
  completeOtpClientFlow: vi.fn(),
  startOtpClientFlow: vi.fn(),
  sendOtpClientFlow: vi.fn(),
}));

vi.mock("@/lib/otp/client", () => ({
  completeOtpClientFlow: clientMocks.completeOtpClientFlow,
  createOtpApiClient: vi.fn(() => clientMocks.api),
  startOtpClientFlow: clientMocks.startOtpClientFlow,
  sendOtpClientFlow: clientMocks.sendOtpClientFlow,
}));

import { usePhoneOtp } from "@/hooks/usePhoneOtp";

function createReactContainer() {
  const noop = () => {};
  const document = {
    nodeType: 9,
    activeElement: null,
    addEventListener: noop,
    removeEventListener: noop,
    defaultView: globalThis,
  };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    nodeName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener: noop,
    removeEventListener: noop,
  };
  document.documentElement = container;
  document.body = container;
  return container;
}

let previousWindow;
let previousIframeElement;
let previousActEnvironment;

beforeEach(() => {
  previousWindow = globalThis.window;
  previousIframeElement = globalThis.HTMLIFrameElement;
  previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.window = globalThis;
  globalThis.HTMLIFrameElement = class HTMLIFrameElement {};
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  clientMocks.startOtpClientFlow.mockReset().mockResolvedValue({
    challengeToken: "challenge-token",
    provider: "twilio",
    retryAfterSeconds: 0,
  });
  clientMocks.sendOtpClientFlow.mockReset();
});

it("retains the prepared token after a failed send across StrictMode renders for a manual retry", async () => {
  let otpFlow;
  const flow = { challengeToken: "private-challenge", provider: "twilio", purpose: "booking", sendStatus: "prepared", recoveryReceipt: "private-send-receipt" };
  const error = Object.assign(new Error("private detail"), { response: { data: { error: "OTP_SEND_PENDING", recoveryReceipt: "private-send-receipt" } } });
  clientMocks.startOtpClientFlow.mockImplementation(async ({ onPrepared }) => {
    onPrepared(flow);
    throw error;
  });
  clientMocks.sendOtpClientFlow.mockImplementation(async ({ flow: retained }) => {
    expect(retained).toBe(flow);
    retained.sendStatus = "sent";
    return retained;
  });
  function Probe() {
    const currentFlow = usePhoneOtp({ purpose: "booking" });
    useEffect(() => { otpFlow = currentFlow; });
    return null;
  }
  const root = createRoot(createReactContainer());
  try {
    await act(async () => root.render(React.createElement(StrictMode, null, React.createElement(Probe))));
    await act(async () => {
      await expect(otpFlow.start("+972521234567")).rejects.toBe(error);
    });
    expect(otpFlow).toMatchObject({ phase: "send-recovery", smsSent: false, error: { code: "OTP_SEND_PENDING" } });
    expect(JSON.stringify(otpFlow)).not.toContain("private-");
    expect(clientMocks.sendOtpClientFlow).not.toHaveBeenCalled();
    await act(async () => { await otpFlow.start("+972521234567"); });
    expect(clientMocks.startOtpClientFlow).toHaveBeenCalledTimes(1);
    expect(clientMocks.sendOtpClientFlow).toHaveBeenCalledTimes(1);
    expect(otpFlow).toMatchObject({ phase: "code", smsSent: true, error: null });
  } finally {
    await act(async () => root.unmount());
  }
});

afterEach(() => {
  globalThis.window = previousWindow;
  globalThis.HTMLIFrameElement = previousIframeElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

it("remains active after a real StrictMode setup-cleanup-setup probe", async () => {
  let otpFlow;
  function Probe() {
    const currentFlow = usePhoneOtp({
      purpose: "booking",
    });
    useEffect(() => { otpFlow = currentFlow; });
    return null;
  }

  const root = createRoot(createReactContainer());
  await act(async () => {
    root.render(
      React.createElement(
        StrictMode,
        null,
        React.createElement(Probe),
      ),
    );
  });

  let outcome;
  await act(async () => {
    outcome = await otpFlow.start("+972521234567");
  });

  expect(outcome).toEqual({ started: true, provider: "twilio" });
  expect(clientMocks.startOtpClientFlow).toHaveBeenCalledTimes(1);
  expect(otpFlow).toMatchObject({
    phase: "code",
    provider: "twilio",
    loading: false,
  });

  await act(async () => {
    root.unmount();
  });
});

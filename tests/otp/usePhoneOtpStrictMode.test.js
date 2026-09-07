import React, { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({
  api: {},
  completeOtpClientFlow: vi.fn(),
  startOtpClientFlow: vi.fn(),
}));

const phoneAuthMocks = vi.hoisted(() => ({
  clearFirebaseRecaptcha: vi.fn(),
  sendFirebaseOtp: vi.fn(),
}));

vi.mock("@/lib/otp/client", () => ({
  completeOtpClientFlow: clientMocks.completeOtpClientFlow,
  createOtpApiClient: vi.fn(() => clientMocks.api),
  startOtpClientFlow: clientMocks.startOtpClientFlow,
}));

vi.mock("@/lib/phoneAuth", () => phoneAuthMocks);

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
    provider: "firebase",
    retryAfterSeconds: 0,
    confirmationResult: { confirm: vi.fn() },
  });
  phoneAuthMocks.clearFirebaseRecaptcha.mockReset();
  phoneAuthMocks.sendFirebaseOtp.mockReset();
});

afterEach(() => {
  globalThis.window = previousWindow;
  globalThis.HTMLIFrameElement = previousIframeElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

it("remains active after a real StrictMode setup-cleanup-setup probe", async () => {
  let otpFlow;
  function Probe() {
    otpFlow = usePhoneOtp({
      purpose: "booking",
      recaptchaContainerId: "strict-mode-recaptcha",
    });
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

  expect(outcome).toEqual({ started: true, provider: "firebase" });
  expect(clientMocks.startOtpClientFlow).toHaveBeenCalledTimes(1);
  expect(otpFlow).toMatchObject({
    phase: "code",
    provider: "firebase",
    loading: false,
  });

  await act(async () => {
    root.unmount();
  });
});

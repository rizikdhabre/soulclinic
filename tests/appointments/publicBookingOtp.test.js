import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OtpVerificationGrantError } from "@/lib/otp/bookingGrant";

const { createAppointmentBookingMock } = vi.hoisted(() => ({
  createAppointmentBookingMock: vi.fn(),
}));

vi.mock("@/lib/appointmentBooking", () => {
  class RequestValidationError extends Error {
    constructor(message = "Missing fields", code = "MISSING_FIELDS") {
      super(message);
      this.code = code;
      this.status = 400;
    }
  }

  return {
    RequestValidationError,
    createAppointmentBooking: createAppointmentBookingMock,
  };
});

vi.mock("@/lib/db", () => ({
  getCollection: vi.fn(),
}));

vi.mock("@/lib/whatsapp", () => ({
  sendWhatsAppTemplate: vi.fn(),
}));

import { POST } from "@/app/api/appointments/route";

const ui = vi.hoisted(() => ({ flow: null, onButton: null }));
// Observe real button props while preserving the components and their handlers.
vi.mock("react/jsx-dev-runtime", async (importOriginal) => {
  const runtime = await importOriginal();
  return {
    ...runtime,
    jsxDEV: (type, props, ...args) => {
      if (type === "button") ui.onButton?.({ props, children: [props.children] });
      return runtime.jsxDEV(type, props, ...args);
    },
  };
});
vi.mock("@/hooks/usePhoneOtp", () => ({ usePhoneOtp: () => ui.flow }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
import { AppointmentForm } from "@/components/ui/AppointmentForm";
import LoginPage from "@/components/ui/LoginPage";

function jsonRequest(body) {
  return new Request("https://example.test/api/appointments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("public appointment OTP grants", () => {
  beforeEach(() => {
    createAppointmentBookingMock.mockReset();
    createAppointmentBookingMock.mockResolvedValue({ success: true });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("always requires OTP when creating a public appointment", async () => {
    const body = {
      phone: "customer-phone",
      date: "2026-08-24",
      time: "10:00",
      verificationToken: "opaque-grant",
    };

    const response = await POST(jsonRequest(body));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(createAppointmentBookingMock).toHaveBeenCalledTimes(1);
    expect(createAppointmentBookingMock).toHaveBeenCalledWith(body, {
      requireOtp: true,
    });
  });

  it.each([
    ["missing", "OTP_VERIFICATION_REQUIRED", 401, "OTP verification is required."],
    ["invalid", "OTP_VERIFICATION_INVALID", 401, "OTP verification is invalid."],
    ["wrong-phone", "OTP_VERIFICATION_INVALID", 401, "OTP verification is invalid."],
    ["expired", "OTP_VERIFICATION_EXPIRED", 401, "OTP verification has expired."],
    [
      "reused",
      "OTP_VERIFICATION_ALREADY_USED",
      409,
      "OTP verification was already used.",
    ],
  ])(
    "maps a %s booking grant to a fixed safe response",
    async (_case, code, status, message) => {
      const error = new OtpVerificationGrantError(code);
      error.message = "private grant detail";
      createAppointmentBookingMock.mockRejectedValue(error);

      const response = await POST(
        jsonRequest({
          phone: "customer-phone",
          date: "2026-08-24",
          time: "10:00",
        }),
      );
      const body = await response.json();

      expect(response.status).toBe(status);
      expect(body).toEqual({ error: code, message });
      expect(JSON.stringify(body)).not.toContain("private grant detail");
    },
  );

  it("uses the linked Task 8 grant consumer and releaser", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/appointmentBooking.js"),
      "utf8",
    );

    expect(source).toContain("consumeBookingGrant");
    expect(source).toContain("releaseBookingGrant");
    expect(source).toContain('from "@/lib/otp/bookingGrant"');
    expect(source).not.toContain('from "@/lib/otpSecurity"');
  });

  it("keeps the admin manual booking endpoint OTP-free", () => {
    const source = readFileSync(
      join(process.cwd(), "src/app/api/admin/bookforCustumer/route.js"),
      "utf8",
    );

    expect(source).toContain("createAppointmentBooking(body, { requireOtp: false })");
  });

  it("keeps a failed appointment resend available without resetting or automatically sending again", () => {
    const source = readFileSync("src/components/ui/AppointmentForm.jsx", "utf8");
    const resendHandler = source.match(/const handleResendOtp = async \(\) => \{([\s\S]*?)\r?\n  \};/)?.[1] || "";
    const resendCatch = resendHandler.match(/catch\s*\{([\s\S]*?)\r?\n\s*\}/)?.[1] || "";
    expect(resendHandler.match(/otpFlow\.resend\(/g) || []).toHaveLength(1);
    expect(resendCatch).not.toContain('setStep("phone")');
    expect(resendCatch).not.toMatch(/otpFlow\.(reset|start|resend)\(/);
  });
});

describe.each([
  ["booking", AppointmentForm, "أدخل رمز التحقق الذي تم إرساله إلى رقمك."],
  ["login", LoginPage, "تم إرسال رمز إلى رقمك. أدخل الرمز للمتابعة."],
])("%s OTP UI", (_purpose, Component, sentMessage) => {
  function render(flow, onButton = () => {}) {
    ui.flow = { phase: "code", provider: "twilio", smsSent: false, canRetrySend: false, loading: false, cooldownSeconds: 0, ...flow };
    ui.onButton = onButton;
    vi.stubGlobal("React", React);
    try {
      return renderToStaticMarkup(React.createElement(Component, {
        selectedDate: new Date("2026-09-11T12:00:00Z"), selectedTime: "10:00", onSubmit: vi.fn(),
      }));
    } finally {
      ui.onButton = null;
      vi.unstubAllGlobals();
    }
  }

  it("shows the prepared code step and explicit pending error without falsely claiming SMS success", () => {
    const html = render({ error: { code: "OTP_SEND_PENDING" } });
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).toContain("لم نتمكن من تأكيد إرسال الرمز");
    expect(html).toContain("إعادة محاولة الإرسال");
    expect(html).not.toContain(sentMessage);
  });

  it("claims a sent SMS only after a confirmed send response", () => {
    expect(render({ smsSent: true, error: null })).toContain(sentMessage);
  });

  it.each([
    ["prepared recovery", true, false, false, true],
    ["successful send", false, true, false, false],
    ["terminal failed send", false, false, false, false],
    ["in-flight recovery", true, false, true, false],
  ])("gates the %s button and handler correctly during a 3360-second cooldown", async (_case, canRetrySend, smsSent, loading, allowed) => {
    const resend = vi.fn().mockResolvedValue({ started: true, provider: "twilio" });
    const buttons = [];
    render({ cooldownSeconds: 3360, canRetrySend, smsSent, loading, resend }, (button) => buttons.push(button));
    const button = buttons.find(({ props }) => props?.onClick?.name === "handleResendOtp");
    expect(button).toBeDefined();
    expect(Boolean(button.props.disabled)).toBe(!allowed);
    expect(resend).not.toHaveBeenCalled();
    if (allowed) {
      expect(button.children.join("")).toContain("إعادة محاولة الإرسال");
      expect(button.children.join("")).not.toContain("3360");
    }
    await button.props.onClick();
    expect(resend).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });

  it("renders distinct actionable public errors", () => {
    const codes = ["INVALID_OTP", "OTP_VERIFICATION_EXPIRED", "OTP_VERIFY_TEMPORARY_FAILURE", "OTP_SERVICE_NOT_CONFIGURED", "OTP_SEND_PENDING", "OTP_SEND_SOURCE_RATE_LIMITED", "OTP_SEND_BUDGET_EXCEEDED", "OTP_COMPLETION_IN_PROGRESS", "OTP_RATE_LIMITED", "OTP_VERIFY_RATE_LIMITED"];
    const messages = codes.map((code) => render({ error: { code } }));
    expect(new Set(messages).size).toBe(codes.length);
  });

  it("keeps the resend disabled for the full global cooldown", () => {
    const html = render({ cooldownSeconds: 86400, error: { code: "OTP_SEND_BUDGET_EXCEEDED" } });
    expect(html).toContain("86400");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*86400/);
  });
});

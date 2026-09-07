import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("returns a failed appointment resend to phone entry without clearing its restriction", () => {
    const source = readFileSync("src/components/ui/AppointmentForm.jsx", "utf8");
    const resendHandler = source.match(/const handleResendOtp = async \(\) => \{([\s\S]*?)\r?\n  \};/)?.[1] || "";
    const resendCatch = resendHandler.match(/catch\s*\{([\s\S]*?)\r?\n\s*\}/)?.[1] || "";
    expect(resendHandler.match(/otpFlow\.resend\(/g) || []).toHaveLength(1);
    expect(resendCatch).toContain('setStep("phone")');
    expect(resendCatch).not.toMatch(/otpFlow\.(reset|start|resend)\(/);
  });
});

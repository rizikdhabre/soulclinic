import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOtpChallenge } from "@/lib/otp/challengeService";
import { completeOtpChallenge } from "@/lib/otp/completionService";

const {
  getCollectionMock,
  verifyTokenMock,
} = vi.hoisted(() => ({
  getCollectionMock: vi.fn(),
  verifyTokenMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getCollection: getCollectionMock,
}));

vi.mock("@/lib/jwt", () => ({
  verifyToken: verifyTokenMock,
}));

import {
  GET as usersGet,
  POST as usersPost,
} from "@/app/api/admin/users/route";
import {
  GET as attendanceGet,
  PATCH as attendancePatch,
} from "@/app/api/admin/attendance/route";
import {
  DELETE as notesDelete,
  POST as notesPost,
  PUT as notesPut,
} from "@/app/api/admin/admin-notes/route";

const ROOT = process.cwd();
const PUBLIC_LOOKUP_ROUTE = join(
  ROOT,
  "src/app/api/appointments/user/route.js",
);
const APPOINTMENT_FORM = join(ROOT, "src/components/ui/AppointmentForm.jsx");
const ADMIN_BOOKING_FORM = join(
  ROOT,
  "src/components/admin/BookForCustomer.jsx",
);

const AUDITED_METHODS = [
  {
    name: "admin/users GET",
    handler: usersGet,
    options: { query: "?phone=0521234567" },
    handlerError: { error: "Failed to fetch users", status: 500 },
    failAt: "collection",
  },
  {
    name: "admin/users POST",
    handler: usersPost,
    options: {
      body: {
        userId: "000000000000000000000001",
        firstName: "Updated First",
        lastName: "Updated Last",
      },
    },
    handlerError: { error: "Failed to update name", status: 500 },
    failAt: "json",
  },
  {
    name: "admin/attendance GET",
    handler: attendanceGet,
    options: { query: "?type=attended" },
    handlerError: { error: "Server error", status: 500 },
    failAt: "collection",
  },
  {
    name: "admin/attendance PATCH",
    handler: attendancePatch,
    options: {
      body: {
        appointmentId: "000000000000000000000002",
        attended: true,
      },
    },
    handlerError: { error: "Server error", status: 500 },
    failAt: "json",
  },
  {
    name: "admin/admin-notes POST",
    handler: notesPost,
    options: { body: { phone: "customer-phone", text: "Admin note" } },
    failAt: "json",
  },
  {
    name: "admin/admin-notes DELETE",
    handler: notesDelete,
    options: { body: { phone: "customer-phone", noteId: "note-id" } },
    failAt: "json",
  },
  {
    name: "admin/admin-notes PUT",
    handler: notesPut,
    options: {
      body: {
        phone: "customer-phone",
        noteId: "note-id",
        text: "Updated note",
      },
    },
    failAt: "json",
  },
];

function genericCollection() {
  return {
    aggregate: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([]) })),
    find: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([]) })),
    findOne: vi.fn().mockResolvedValue(null),
    findOneAndUpdate: vi.fn().mockResolvedValue({
      phone: "+972521234567",
    }),
    updateMany: vi.fn().mockResolvedValue({ matchedCount: 0 }),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
  };
}

function adminRequest({ cookie, body = {}, query = "" } = {}) {
  return {
    url: `https://example.test/api/admin/resource${query}`,
    cookies: {
      get: vi.fn((name) =>
        name === "token" && cookie ? { value: cookie } : undefined,
      ),
    },
    json: vi.fn().mockResolvedValue(body),
  };
}

function expectNoHandlerWork(request, collection) {
  expect(request.json).not.toHaveBeenCalled();
  expect(getCollectionMock).not.toHaveBeenCalled();
  for (const method of Object.values(collection)) {
    expect(method).not.toHaveBeenCalled();
  }
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:js|jsx|mjs)$/.test(entry.name) ? [path] : [];
  });
}

describe("admin PII route boundaries", () => {
  let collection;

  beforeEach(() => {
    verifyTokenMock.mockReset();
    getCollectionMock.mockReset();
    collection = genericCollection();
    getCollectionMock.mockResolvedValue(collection);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it.each(AUDITED_METHODS)(
    "$name rejects a missing cookie before parsing or data access",
    async ({ handler, options }) => {
      const request = adminRequest(options);

      const response = await handler(request, { params: Promise.resolve({}) });

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: "UNAUTHORIZED",
        message: "Admin login is required.",
      });
      expect(verifyTokenMock).not.toHaveBeenCalled();
      expectNoHandlerWork(request, collection);
    },
  );

  it.each(AUDITED_METHODS)(
    "$name rejects an invalid cookie before parsing or data access",
    async ({ handler, options }) => {
      verifyTokenMock.mockReturnValue(null);
      const request = adminRequest({ ...options, cookie: "opaque-cookie" });

      const response = await handler(request, { params: Promise.resolve({}) });

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: "UNAUTHORIZED",
        message: "Admin login is required.",
      });
      expect(verifyTokenMock).toHaveBeenCalledTimes(1);
      expectNoHandlerWork(request, collection);
    },
  );

  it.each(AUDITED_METHODS)(
    "$name rejects a non-admin cookie before parsing or data access",
    async ({ handler, options }) => {
      verifyTokenMock.mockReturnValue({ role: "customer" });
      const request = adminRequest({ ...options, cookie: "opaque-cookie" });

      const response = await handler(request, { params: Promise.resolve({}) });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "FORBIDDEN",
        message: "Admin permissions are required.",
      });
      expect(verifyTokenMock).toHaveBeenCalledTimes(1);
      expectNoHandlerWork(request, collection);
    },
  );

  it.each(AUDITED_METHODS)(
    "$name reaches its real handler for an admin cookie",
    async ({ handler, options, failAt }) => {
      verifyTokenMock.mockReturnValue({ role: "admin", adminId: "admin-id" });
      const request = adminRequest({ ...options, cookie: "opaque-cookie" });

      const response = await handler(request, { params: Promise.resolve({}) });

      expect(response.status).toBe(200);
      expect(verifyTokenMock).toHaveBeenCalledTimes(1);
      expect(getCollectionMock).toHaveBeenCalled();
      if (failAt === "json") {
        expect(request.json).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each(AUDITED_METHODS)(
    "$name preserves its existing non-auth handler error behavior",
    async ({ handler, options, handlerError, failAt }) => {
      verifyTokenMock.mockReturnValue({ role: "admin" });
      const request = adminRequest({ ...options, cookie: "opaque-cookie" });
      const routeError = new Error("handler failed");

      if (failAt === "collection") {
        getCollectionMock.mockRejectedValue(routeError);
      } else {
        request.json.mockRejectedValue(routeError);
      }

      if (!handlerError) {
        await expect(
          handler(request, { params: Promise.resolve({}) }),
        ).rejects.toBe(routeError);
        return;
      }

      const response = await handler(request, { params: Promise.resolve({}) });
      expect(response.status).toBe(handlerError.status);
      expect(await response.json()).toEqual({ error: handlerError.error });
    },
  );

  it("returns only the minimized normalized profile for an admin phone lookup", async () => {
    verifyTokenMock.mockReturnValue({ role: "admin" });
    const users = genericCollection();
    users.findOne.mockResolvedValue({
      _id: "private-id",
      firstName: "First",
      lastName: "Last",
      notes: ["private-note"],
      appointments: ["private-appointment"],
    });
    getCollectionMock.mockResolvedValue(users);

    const response = await usersGet(
      adminRequest({ cookie: "opaque-cookie", query: "?phone=0521234567" }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      exists: true,
      phone: "+972521234567",
      firstName: "First",
      lastName: "Last",
    });
    expect(Object.keys(body)).toEqual([
      "exists",
      "phone",
      "firstName",
      "lastName",
    ]);
    expect(users.findOne).toHaveBeenCalledWith(
      { phone: "+972521234567" },
      { projection: { _id: 0, firstName: 1, lastName: 1 } },
    );
  });

  it("rejects an explicit empty phone query before touching the collection", async () => {
    verifyTokenMock.mockReturnValue({ role: "admin" });

    const response = await usersGet(
      adminRequest({ cookie: "opaque-cookie", query: "?phone=" }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "INVALID_PHONE" });
    expect(getCollectionMock).not.toHaveBeenCalled();
  });

  it("preserves the authenticated all-users response when no phone is supplied", async () => {
    verifyTokenMock.mockReturnValue({ role: "admin" });
    const users = genericCollection();
    users.find.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([
        {
          _id: { toString: () => "user-id" },
          phone: "+972521234567",
          firstName: "First",
          lastName: "Last",
        },
      ]),
    });
    getCollectionMock.mockResolvedValue(users);

    const response = await usersGet(adminRequest({ cookie: "opaque-cookie" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      {
        _id: "user-id",
        phone: "+972521234567",
        firstName: "First",
        lastName: "Last",
      },
    ]);
  });
});

describe("customer identity lookup boundary", () => {
  it("removes the public lookup route and migrates both callers", () => {
    expect(existsSync(PUBLIC_LOOKUP_ROUTE)).toBe(false);

    const appointmentForm = readFileSync(APPOINTMENT_FORM, "utf8");
    const adminBookingForm = readFileSync(ADMIN_BOOKING_FORM, "utf8");
    expect(appointmentForm).not.toContain("/api/appointments/user");
    expect(adminBookingForm).toContain("/api/admin/users");

    const remainingPublicLookupCallers = sourceFiles(join(ROOT, "src"))
      .filter((path) => readFileSync(path, "utf8").includes("/api/appointments/user"))
      .map((path) => path.slice(ROOT.length + 1));
    expect(remainingPublicLookupCallers).toEqual([]);
  });

  it("uses one stable booking reCAPTCHA container and no direct OTP transport", () => {
    const source = readFileSync(APPOINTMENT_FORM, "utf8");

    expect(source).toContain("usePhoneOtp({");
    expect(source).toContain('purpose: "booking"');
    expect(source).toContain(
      'recaptchaContainerId: "appointment-recaptcha-container"',
    );
    expect(
      source.match(/<div id="appointment-recaptcha-container" \/>/g) || [],
    ).toHaveLength(1);
    expect(source).not.toMatch(/\/api\/otp\/(?:start|verify)/);
    expect(source).not.toContain("createBackendOtpConfirmation");
    expect(source).not.toContain("handleLookupUser");
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("OTP_RESEND_COOLDOWN_SECONDS");
    expect(source).toContain('from "@/lib/bookingFormFlow"');
    expect(source.match(/createBookingFormFlow\(/g) || []).toHaveLength(1);
    expect(source.match(/bookingFlow\.acceptCompletion\(/g) || []).toHaveLength(1);
    expect(source.match(/bookingFlow\.submit\(/g) || []).toHaveLength(1);
    expect(source).toContain("bookingFlow.phoneChanged()");
    expect(source).toContain("bookingFlow.reset()");
    expect(source).toContain("onClick={handleRetryBooking}");
    expect(source).toContain("إعادة محاولة حفظ الموعد");
    expect(source).not.toContain("pendingVerificationToken");
    expect(source.match(/otpFlow\.start\(/g) || []).toHaveLength(1);
    expect(source).toMatch(
      /const startOutcome = await otpFlow\.start\(normalizedPhone\)[\s\S]{0,100}if \(!startOutcome\.started\) return;[\s\S]{0,100}setStep\("otp"\)/,
    );
    expect(source.match(/otpFlow\.verify\(/g) || []).toHaveLength(1);
    expect(source.match(/otpFlow\.resend\(/g) || []).toHaveLength(1);
    expect(source).toMatch(
      /case "INVALID_OTP":\s*case "OTP_VERIFICATION_INVALID":/,
    );
  });

  it("does not expose customer fields in a new OTP challenge", async () => {
    const now = new Date("2026-08-23T12:00:00.000Z");
    const result = await createOtpChallenge(
      {
        request: {},
        phone: "0521234567",
        purpose: "booking",
      },
      {
        env: { NODE_ENV: "production" },
        deriveSourceHash: vi.fn().mockResolvedValue("source-hash"),
        rateStore: {
          claimSourceAction: vi.fn().mockResolvedValue({}),
          claimPhoneStart: vi.fn().mockResolvedValue({ retryAfterSeconds: 60 }),
        },
        tokenFactory: vi.fn().mockReturnValue("opaque-challenge"),
        hashToken: vi.fn().mockReturnValue("challenge-hash"),
        clock: { now: () => now },
        challengeStore: {
          rotate: vi.fn().mockResolvedValue({ _id: "challenge-id" }),
        },
      },
    );

    expect(result).toEqual({
      challengeToken: "opaque-challenge",
      provider: "firebase",
      expiresAt: new Date("2026-08-23T12:10:00.000Z"),
      retryAfterSeconds: 60,
      retryAt: "2026-08-23T12:01:00.000Z",
      serverTime: "2026-08-23T12:00:00.000Z",
      correlationId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    });
    expect(result).not.toHaveProperty("exists");
    expect(result).not.toHaveProperty("firstName");
    expect(result).not.toHaveProperty("lastName");
    expect(result).not.toHaveProperty("profile");
  });

  it("does not read a profile when completion evidence fails", async () => {
    const now = new Date("2026-08-23T12:00:00.000Z");
    const usersData = { findOne: vi.fn() };
    const issueBookingGrant = vi.fn();
    const evidenceError = Object.assign(new Error("invalid evidence"), {
      code: "INVALID_FIREBASE_TOKEN",
      status: 401,
    });

    await expect(
      completeOtpChallenge(
        {
          challengeToken: "opaque-challenge",
          provider: "firebase",
          idToken: "opaque-evidence",
        },
        {
          hashChallengeToken: vi.fn().mockReturnValue("challenge-hash"),
          challengeStore: {
            findByTokenHash: vi.fn().mockResolvedValue({
              _id: "challenge-id",
              challengeTokenHash: "challenge-hash",
              phone: "+972521234567",
              purpose: "booking",
              provider: "firebase",
              status: "pending",
              createdAt: new Date("2026-08-23T11:59:00.000Z"),
              expiresAt: new Date("2026-08-23T12:10:00.000Z"),
            }),
          },
          clock: { now: () => now },
          verifyFirebaseEvidence: vi.fn().mockRejectedValue(evidenceError),
          usersData,
          issueBookingGrant,
        },
      ),
    ).rejects.toBe(evidenceError);
    expect(usersData.findOne).not.toHaveBeenCalled();
    expect(issueBookingGrant).not.toHaveBeenCalled();
  });
});

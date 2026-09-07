import { describe, expect, it, vi } from "vitest";
import { OtpError } from "@/lib/otp/errors";
import { verifyFirebaseEvidence } from "@/lib/otp/firebaseEvidence";

const phone = "+972521234567";
const createdAt = new Date("2026-08-23T12:00:00.000Z");
const now = new Date("2026-08-23T12:01:00.000Z");
const transientToken = "test-transient-firebase-id-token";

function activeChallenge(overrides = {}) {
  return {
    phone,
    provider: "firebase",
    status: "pending",
    createdAt,
    expiresAt: new Date("2026-08-23T12:10:00.000Z"),
    ...overrides,
  };
}

function decodedToken(overrides = {}) {
  return {
    phone_number: phone,
    auth_time: Math.floor(createdAt.getTime() / 1000),
    firebase: { sign_in_provider: "phone" },
    ...overrides,
  };
}

function logger() {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

async function expectInvalid(input, adminAuth) {
  const testLogger = logger();
  let thrown;

  try {
    await verifyFirebaseEvidence(input, { adminAuth, logger: testLogger });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(OtpError);
  expect(thrown).toMatchObject({
    code: "INVALID_FIREBASE_TOKEN",
    status: 401,
    message: "Invalid Firebase phone verification.",
  });
  expect(String(thrown)).not.toContain(transientToken);
  expect(JSON.stringify(thrown)).not.toContain(transientToken);
  for (const method of Object.values(testLogger)) {
    expect(method).not.toHaveBeenCalled();
  }
}

describe("verifyFirebaseEvidence", () => {
  it("accepts a fresh matching Firebase phone token", async () => {
    const adminAuth = { verifyIdToken: vi.fn().mockResolvedValue(decodedToken()) };

    await expect(
      verifyFirebaseEvidence(
        { idToken: transientToken, challenge: activeChallenge(), now },
        { adminAuth },
      ),
    ).resolves.toBe(phone);
    expect(adminAuth.verifyIdToken).toHaveBeenCalledTimes(1);
    expect(adminAuth.verifyIdToken).toHaveBeenCalledWith(transientToken);
  });

  it("accepts authentication timestamps on both skew boundaries", async () => {
    const adminAuth = {
      verifyIdToken: vi
        .fn()
        .mockResolvedValueOnce(
          decodedToken({ auth_time: Math.floor((createdAt.getTime() - 120_000) / 1000) }),
        )
        .mockResolvedValueOnce(
          decodedToken({ auth_time: Math.floor((now.getTime() + 120_000) / 1000) }),
        ),
    };

    await expect(
      verifyFirebaseEvidence(
        { idToken: transientToken, challenge: activeChallenge(), now },
        { adminAuth },
      ),
    ).resolves.toBe(phone);
    await expect(
      verifyFirebaseEvidence(
        { idToken: transientToken, challenge: activeChallenge(), now },
        { adminAuth },
      ),
    ).resolves.toBe(phone);
  });

  it("sanitizes provider verification failures without leaking the token", async () => {
    const adminAuth = {
      verifyIdToken: vi.fn().mockRejectedValue(new Error(`provider detail: ${transientToken}`)),
    };

    await expectInvalid({ idToken: transientToken, challenge: activeChallenge(), now }, adminAuth);
    expect(adminAuth.verifyIdToken).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing provider token", async () => {
    const adminAuth = { verifyIdToken: vi.fn().mockResolvedValue(decodedToken()) };

    await expectInvalid({ challenge: activeChallenge(), now }, adminAuth);
  });

  it.each([undefined, "not-an-israeli-mobile-number"])
    ("rejects an absent or malformed phone claim: %s", async (phoneNumber) => {
      const adminAuth = {
        verifyIdToken: vi.fn().mockResolvedValue(decodedToken({ phone_number: phoneNumber })),
      };

      await expectInvalid(
        { idToken: transientToken, challenge: activeChallenge(), now },
        adminAuth,
      );
    });

  it("rejects a token for a different normalized phone", async () => {
    const adminAuth = {
      verifyIdToken: vi.fn().mockResolvedValue(decodedToken({ phone_number: "+972531234567" })),
    };

    await expectInvalid({ idToken: transientToken, challenge: activeChallenge(), now }, adminAuth);
  });

  it("rejects a non-phone Firebase sign-in provider", async () => {
    const adminAuth = {
      verifyIdToken: vi.fn().mockResolvedValue(
        decodedToken({ firebase: { sign_in_provider: "password" } }),
      ),
    };

    await expectInvalid({ idToken: transientToken, challenge: activeChallenge(), now }, adminAuth);
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, "1760000000"])
    ("rejects a missing or non-finite auth_time: %s", async (authTime) => {
      const adminAuth = { verifyIdToken: vi.fn().mockResolvedValue(decodedToken({ auth_time: authTime })) };

      await expectInvalid(
        { idToken: transientToken, challenge: activeChallenge(), now },
        adminAuth,
      );
    });

  it("rejects auth_time older than the allowed creation skew", async () => {
    const adminAuth = {
      verifyIdToken: vi.fn().mockResolvedValue(
        decodedToken({ auth_time: Math.floor((createdAt.getTime() - 120_001) / 1000) }),
      ),
    };

    await expectInvalid({ idToken: transientToken, challenge: activeChallenge(), now }, adminAuth);
  });

  it("rejects auth_time later than the allowed future skew", async () => {
    const adminAuth = {
      verifyIdToken: vi.fn().mockResolvedValue(
        decodedToken({ auth_time: Math.floor((now.getTime() + 121_000) / 1000) }),
      ),
    };

    await expectInvalid({ idToken: transientToken, challenge: activeChallenge(), now }, adminAuth);
  });

  it.each([
    { provider: "twilio" },
    { status: "twilio_sent" },
  ])("rejects an inactive Firebase challenge: %j", async (overrides) => {
    const adminAuth = { verifyIdToken: vi.fn().mockResolvedValue(decodedToken()) };

    await expectInvalid(
      { idToken: transientToken, challenge: activeChallenge(overrides), now },
      adminAuth,
    );
  });

  it.each([
    { createdAt: undefined },
    { createdAt: new Date("invalid") },
    { expiresAt: undefined },
    { expiresAt: new Date("invalid") },
  ])("rejects malformed challenge dates: %j", async (overrides) => {
    const adminAuth = { verifyIdToken: vi.fn().mockResolvedValue(decodedToken()) };

    await expectInvalid(
      { idToken: transientToken, challenge: activeChallenge(overrides), now },
      adminAuth,
    );
  });

  it("rejects an expired challenge", async () => {
    const adminAuth = { verifyIdToken: vi.fn().mockResolvedValue(decodedToken()) };

    await expectInvalid(
      {
        idToken: transientToken,
        challenge: activeChallenge({ expiresAt: new Date(now) }),
        now,
      },
      adminAuth,
    );
  });

  it("rejects a malformed challenge phone and malformed verifier clock", async () => {
    const adminAuth = { verifyIdToken: vi.fn().mockResolvedValue(decodedToken()) };

    await expectInvalid(
      { idToken: transientToken, challenge: activeChallenge({ phone: "invalid" }), now },
      adminAuth,
    );
    await expectInvalid(
      { idToken: transientToken, challenge: activeChallenge(), now: new Date("invalid") },
      adminAuth,
    );
  });

  it.each([
    ["an array", [phone]],
    ["a numeric value", 972521234567],
    ["an object with a custom toString", { toString: () => phone }],
    ["an object with a non-callable toString", { toString: null }],
  ])("rejects decoded phone claims supplied as %s", async (_description, phoneNumber) => {
    const adminAuth = {
      verifyIdToken: vi.fn().mockResolvedValue(decodedToken({ phone_number: phoneNumber })),
    };

    await expectInvalid(
      { idToken: transientToken, challenge: activeChallenge(), now },
      adminAuth,
    );
  });

  it.each([
    ["an array", [phone]],
    ["a numeric value", 972521234567],
    ["an object with a custom toString", { toString: () => phone }],
    ["an object with a non-callable toString", { toString: null }],
  ])("rejects challenge phone values supplied as %s", async (_description, challengePhone) => {
    const adminAuth = { verifyIdToken: vi.fn().mockResolvedValue(decodedToken()) };

    await expectInvalid(
      {
        idToken: transientToken,
        challenge: activeChallenge({ phone: challengePhone }),
        now,
      },
      adminAuth,
    );
  });

  it.each([
    ["a string", "1760000000"],
    ["a boolean", true],
    ["a bigint", 1n],
    ["a symbol", Symbol("auth-time")],
    ["an object with a throwing valueOf", { valueOf: () => { throw new Error("unsafe"); } }],
  ])("rejects auth_time supplied as %s", async (_description, authTime) => {
    const adminAuth = { verifyIdToken: vi.fn().mockResolvedValue(decodedToken({ auth_time: authTime })) };

    await expectInvalid(
      { idToken: transientToken, challenge: activeChallenge(), now },
      adminAuth,
    );
  });

  it("sanitizes a throw from a decoded claim getter", async () => {
    const decoded = decodedToken();
    Object.defineProperty(decoded, "phone_number", {
      get() {
        throw new Error("unsafe claim getter");
      },
    });
    const adminAuth = { verifyIdToken: vi.fn().mockResolvedValue(decoded) };

    await expectInvalid({ idToken: transientToken, challenge: activeChallenge(), now }, adminAuth);
  });
});

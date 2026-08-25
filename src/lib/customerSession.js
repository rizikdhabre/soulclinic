import { SignJWT, jwtVerify } from "jose";
import { normalizeIsraeliPhone } from "@/lib/phone";

const CUSTOMER_SESSION_COOKIE = "customer_session";
const CUSTOMER_SESSION_DEFAULT_TTL_SECONDS = 3_600;
const CUSTOMER_SESSION_ISSUER = "soulclinic";
const CUSTOMER_SESSION_AUDIENCE = "soulclinic-customer";
const CUSTOMER_SESSION_ALGORITHM = "HS256";
const ERROR_DETAILS = {
  CUSTOMER_UNAUTHORIZED: [401, "Customer session is invalid or expired."],
  CUSTOMER_SESSION_NOT_CONFIGURED: [503, "Customer session is unavailable."],
  CUSTOMER_SESSION_INVALID_IDENTITY: [500, "Customer session could not be created."],
};

class CustomerSessionError extends Error {
  constructor(code) {
    const [status, message] =
      ERROR_DETAILS[code] ?? ERROR_DETAILS.CUSTOMER_UNAUTHORIZED;
    super(message);
    this.name = "CustomerSessionError";
    this.code = Object.hasOwn(ERROR_DETAILS, code)
      ? code
      : "CUSTOMER_UNAUTHORIZED";
    this.status = status;
  }
}

function configurationError() {
  return new CustomerSessionError("CUSTOMER_SESSION_NOT_CONFIGURED");
}

function unauthorizedError() {
  return new CustomerSessionError("CUSTOMER_UNAUTHORIZED");
}

function optionEnvironment(options) {
  return options?.env ?? process.env;
}

function sessionSecret(options = {}) {
  const secret = Object.hasOwn(options, "secret")
    ? options.secret
    : optionEnvironment(options).CUSTOMER_SESSION_SECRET;
  if (typeof secret !== "string" || secret.length < 32) {
    throw configurationError();
  }
  return new TextEncoder().encode(secret);
}

export function getCustomerSessionTtlSeconds(options = {}) {
  const configured = Object.hasOwn(options, "ttlSeconds")
    ? options.ttlSeconds
    : optionEnvironment(options).CUSTOMER_SESSION_TTL_SECONDS;
  if (configured === undefined) return CUSTOMER_SESSION_DEFAULT_TTL_SECONDS;
  if (typeof configured !== "string" && typeof configured !== "number") {
    throw configurationError();
  }
  if (typeof configured === "string" && !configured.trim()) {
    throw configurationError();
  }

  const ttlSeconds = Number(configured);
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw configurationError();
  }
  return ttlSeconds;
}

function sessionNow(options = {}) {
  const now = options.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw configurationError();
  }
  return new Date(now);
}

function normalizedSessionPhone(phone) {
  if (typeof phone !== "string" || normalizeIsraeliPhone(phone) !== phone) {
    throw new CustomerSessionError("CUSTOMER_SESSION_INVALID_IDENTITY");
  }
  return phone;
}

export async function signCustomerSession(phone, options = {}) {
  const secret = sessionSecret(options);
  const ttlSeconds = getCustomerSessionTtlSeconds(options);
  const now = sessionNow(options);
  const normalizedPhone = normalizedSessionPhone(phone);
  const issuedAt = Math.floor(now.getTime() / 1_000);
  const expiresAt = issuedAt + ttlSeconds;
  if (!Number.isSafeInteger(expiresAt)) {
    throw configurationError();
  }

  return new SignJWT({ type: "customer", phone: normalizedPhone })
    .setProtectedHeader({ alg: CUSTOMER_SESSION_ALGORITHM })
    .setIssuer(CUSTOMER_SESSION_ISSUER)
    .setAudience(CUSTOMER_SESSION_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(secret);
}

export async function verifyCustomerSession(token, options = {}) {
  const secret = sessionSecret(options);
  const now = sessionNow(options);

  try {
    if (typeof token !== "string" || !token.trim()) throw unauthorizedError();
    const { payload } = await jwtVerify(token, secret, {
      algorithms: [CUSTOMER_SESSION_ALGORITHM],
      issuer: CUSTOMER_SESSION_ISSUER,
      audience: CUSTOMER_SESSION_AUDIENCE,
      currentDate: now,
      requiredClaims: ["iat", "exp", "type", "phone"],
    });
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    if (
      payload.type !== "customer" ||
      typeof payload.phone !== "string" ||
      normalizeIsraeliPhone(payload.phone) !== payload.phone ||
      !Number.isSafeInteger(payload.iat) ||
      !Number.isSafeInteger(payload.exp) ||
      payload.iat > nowSeconds ||
      payload.exp <= payload.iat
    ) {
      throw unauthorizedError();
    }

    return { type: "customer", phone: payload.phone };
  } catch {
    throw unauthorizedError();
  }
}

export async function requireCustomerSession(request, options = {}) {
  let token;
  try {
    token = request?.cookies?.get(CUSTOMER_SESSION_COOKIE)?.value;
  } catch {
    throw unauthorizedError();
  }
  if (!token) throw unauthorizedError();
  return verifyCustomerSession(token, options);
}

function customerCookieOptions(maxAge) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge,
  };
}

export function setCustomerSessionCookie(response, token, ttl) {
  const maxAge = getCustomerSessionTtlSeconds({ ttlSeconds: ttl });
  response.cookies.set(
    CUSTOMER_SESSION_COOKIE,
    token,
    customerCookieOptions(maxAge),
  );
}

export function clearCustomerSessionCookie(response) {
  response.cookies.set(
    CUSTOMER_SESSION_COOKIE,
    "",
    customerCookieOptions(0),
  );
}

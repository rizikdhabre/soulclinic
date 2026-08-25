import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/jwt";

const AUTH_ERRORS = {
  UNAUTHORIZED: {
    status: 401,
    message: "Admin login is required.",
  },
  FORBIDDEN: {
    status: 403,
    message: "Admin permissions are required.",
  },
};

export class AdminAuthError extends Error {
  constructor(code) {
    const details = AUTH_ERRORS[code] ?? AUTH_ERRORS.UNAUTHORIZED;
    super(details.message);
    this.name = "AdminAuthError";
    this.code = Object.hasOwn(AUTH_ERRORS, code) ? code : "UNAUTHORIZED";
    this.status = details.status;
  }
}

export function requireAdmin(request) {
  const token = request?.cookies?.get("token")?.value;
  if (!token) throw new AdminAuthError("UNAUTHORIZED");

  const payload = verifyToken(token);
  if (!payload) throw new AdminAuthError("UNAUTHORIZED");
  if (payload.role !== "admin") throw new AdminAuthError("FORBIDDEN");

  return payload;
}

function adminAuthResponse(error) {
  return NextResponse.json(
    { error: error.code, message: error.message },
    { status: error.status },
  );
}

export function withAdminRoute(handler) {
  return async function authenticatedAdminRoute(...args) {
    try {
      requireAdmin(args[0]);
    } catch (error) {
      if (error instanceof AdminAuthError) return adminAuthResponse(error);
      throw error;
    }

    return handler(...args);
  };
}

import { NextResponse } from "next/server";
import { OtpError, otpErrorMetadata } from "./errors";
import { projectFirebaseDiagnostic } from "./firebaseDiagnostics";

const ERRORS = new Set(["OTP_CHALLENGE_FAILED", "OTP_CHALLENGE_EXPIRED", "OTP_RECOVERY_INVALID", "OTP_PROVIDER_REJECTED", "OTP_PERSISTENCE_FAILED", "OTP_RATE_LIMITED", "OTP_SEND_SOURCE_RATE_LIMITED", "OTP_SEND_BUDGET_EXCEEDED", "OTP_SEND_FAILED", "OTP_SEND_PENDING", "OTP_SERVICE_NOT_CONFIGURED", "OTP_SOURCE_UNAVAILABLE", "OTP_STATE_BUSY"]);
const bounded = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;

export async function handleFirebaseOtpRequest(request, service, fallback = false) {
  try {
    let body;
    try { body = await request.json(); } catch { throw new OtpError("OTP_CHALLENGE_FAILED", 400, "Invalid request."); }
    if (!body || typeof body !== "object" || Array.isArray(body) || !/^[\w-]{43}$/.test(body.challengeToken) ||
      typeof body.challengeToken !== "string" || (body.firebaseSendId !== undefined && !bounded(body.firebaseSendId, 36)) ||
      (body.recoveryReceipt !== undefined && !bounded(body.recoveryReceipt, 2048))) throw new OtpError("OTP_CHALLENGE_FAILED", 400, "Invalid request.");
    const failure = body.failure && typeof body.failure === "object" && !Array.isArray(body.failure) &&
      bounded(body.failure.code, 80) && bounded(body.failure.stage, 40) && bounded(body.failure.provenance, 40)
      ? { code: body.failure.code, stage: body.failure.stage, provenance: body.failure.provenance } : undefined;
    const diagnostic = projectFirebaseDiagnostic(body.diagnostic);
    const result = await service({ request, challengeToken: body.challengeToken, firebaseSendId: body.firebaseSendId,
      ...(Object.keys(diagnostic).length ? { diagnostic } : {}),
      ...(fallback ? { failure, recoveryReceipt: body.recoveryReceipt } : { operation: body.operation, failure }) });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const trusted = error instanceof OtpError && ERRORS.has(error.code) ? error : undefined;
    const status = Number.isInteger(trusted?.status) && trusted.status >= 400 && trusted.status <= 599 ? trusted.status : 503;
    const metadata = otpErrorMetadata(trusted);
    return NextResponse.json({ error: trusted?.code ?? "OTP_SEND_FAILED", message: "The verification request could not be completed.", ...metadata,
      ...(bounded(trusted?.recoveryReceipt, 2048) ? { recoveryReceipt: trusted.recoveryReceipt } : {}),
      ...(trusted?.restartAllowed === true ? { restartAllowed: true } : {}) },
    { status, headers: { "Cache-Control": "no-store", ...(status === 429 && metadata.retryAfterSeconds ? { "Retry-After": String(metadata.retryAfterSeconds) } : {}) } });
  }
}

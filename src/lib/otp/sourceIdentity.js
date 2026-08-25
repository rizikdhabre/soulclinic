import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { OtpError } from "./errors";

const DEVELOPMENT_SOURCE = "development-local-source";

function unavailable() {
  return new OtpError(
    "OTP_SOURCE_UNAVAILABLE",
    503,
    "OTP source identity is unavailable.",
  );
}

function normalizeIp(value) {
  if (typeof value !== "string" || value.includes(",")) return null;

  const candidate = value.trim();
  const family = isIP(candidate);
  if (family === 0) return null;
  if (family === 4) return candidate;

  const hostname = new URL(`http://[${candidate}]/`).hostname;
  return hostname.slice(1, -1);
}

export function deriveOtpSourceHash(request, options = {}) {
  const env = options.env ?? process.env;
  const secret = env?.OTP_SOURCE_HASH_SECRET;
  if (typeof secret !== "string" || secret.length === 0) throw unavailable();

  let source = DEVELOPMENT_SOURCE;
  if (env?.NODE_ENV === "production") {
    if (env?.VERCEL !== "1") throw unavailable();

    source = normalizeIp(request?.headers?.get("x-vercel-forwarded-for"));
    if (!source) throw unavailable();
  }

  return createHmac("sha256", secret).update(source, "utf8").digest("hex");
}

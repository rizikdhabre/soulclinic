import "server-only";
import { OtpError } from "./errors";

const APP_NAME = "soulclinic-otp-auth";
let authPromise;
let authProjectId;

function configurationError() {
  return new OtpError("OTP_SERVICE_NOT_CONFIGURED", 503, "Phone verification is not configured.");
}

function setting(value) {
  if (value == null) return "";
  if (typeof value !== "string") throw configurationError();
  return value.trim();
}

export function getFirebaseProjectId(env = process.env) {
  const projectId = setting(env?.FIREBASE_PROJECT_ID);
  const publicProjectId = setting(env?.NEXT_PUBLIC_FIREBASE_PROJECT_ID);
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) ||
      (publicProjectId && publicProjectId !== projectId) ||
      env?.FIREBASE_AUTH_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw configurationError();
  }
  return projectId;
}

async function initializeAuth({ projectId, clientEmail, privateKey }) {
  const { getApps, initializeApp, cert, applicationDefault } = await import("firebase-admin/app");
  const { getAuth } = await import("firebase-admin/auth");
  let app = getApps().find((candidate) => candidate.name === APP_NAME);
  if (app && app.options.projectId !== projectId) throw configurationError();
  if (!app) {
    const credential = clientEmail
      ? cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, "\n") })
      : applicationDefault();
    app = initializeApp({ projectId, credential }, APP_NAME);
  }
  return getAuth(app);
}

export function getFirebaseAdminAuth({ env = process.env } = {}) {
  let config;
  try {
    const projectId = getFirebaseProjectId(env);
    const clientEmail = setting(env?.FIREBASE_CLIENT_EMAIL);
    const privateKey = setting(env?.FIREBASE_PRIVATE_KEY);
    if (Boolean(clientEmail) !== Boolean(privateKey) || (authPromise && authProjectId !== projectId)) {
      throw configurationError();
    }
    config = { projectId, clientEmail, privateKey };
  } catch {
    return Promise.reject(configurationError());
  }

  if (!authPromise) {
    authProjectId = config.projectId;
    // A failed attempt must not poison future requests; a created named app can be reused.
    authPromise = initializeAuth(config).catch((error) => {
      authPromise = undefined;
      authProjectId = undefined;
      if (["OTP_SERVICE_NOT_CONFIGURED", "app/invalid-credential", "app/invalid-app-options",
        "auth/invalid-credential", "auth/invalid-config"].includes(error?.code)) throw configurationError();
      throw new OtpError("OTP_VERIFY_TEMPORARY_FAILURE", 503, "Phone verification is temporarily unavailable.");
    });
  }
  return authPromise;
}

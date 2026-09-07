import { RecaptchaVerifier, signInWithPhoneNumber } from "firebase/auth";
import { auth } from "./firebase";
import { classifyFirebaseSendError } from "./otp/firebaseErrors";
import {
  FIREBASE_RECAPTCHA_SETUP_FAILED,
  FirebaseRecaptchaSetupError,
} from "./otp/firebaseSetupError";

const verifiers = new Map();
const sendsInProgress = new Set();
const pendingClears = new Set();

function getCurrentDomain() {
  if (typeof window === "undefined") return "server";
  return window.location.hostname;
}

function getSafeFirebaseErrorCode(error) {
  if (error instanceof FirebaseRecaptchaSetupError) {
    return FIREBASE_RECAPTCHA_SETUP_FAILED;
  }
  return typeof error?.code === "string" &&
    /^auth\/[a-z0-9-]{1,59}$/.test(error.code)
    ? error.code
    : "auth/unknown";
}

function clearVerifier(containerId, expectedVerifier) {
  const verifier = verifiers.get(containerId);
  if (expectedVerifier && verifier !== expectedVerifier) return;

  if (sendsInProgress.has(containerId)) {
    pendingClears.add(containerId);
    return;
  }

  pendingClears.delete(containerId);
  if (!verifier) return;

  verifiers.delete(containerId);
  try {
    verifier.clear();
  } catch (error) {
    console.warn("Failed to clear Firebase reCAPTCHA verifier", {
      code: getSafeFirebaseErrorCode(error),
    });
  }
}

export function clearFirebaseRecaptcha(containerId) {
  clearVerifier(containerId);
}

function getOrCreateRecaptchaVerifier(containerId) {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("Firebase phone OTP can only be sent from the browser.");
  }

  const container = document.getElementById(containerId);
  if (!container) {
    throw new FirebaseRecaptchaSetupError();
  }

  if (!verifiers.has(containerId)) {
    let verifier;
    try {
      verifier = new RecaptchaVerifier(auth, containerId, {
        size: "invisible",
        "expired-callback": () => clearVerifier(containerId, verifier),
      });
    } catch (error) {
      // Preserve SDK codes and browser security/unsupported errors as-is.
      if (
        error instanceof Error &&
        error.code == null &&
        (error.name === "Error" || error.name === "TypeError")
      ) {
        throw new FirebaseRecaptchaSetupError();
      }
      throw error;
    }
    verifiers.set(containerId, verifier);
  }

  return verifiers.get(containerId);
}

function logOtpError(error, stage) {
  console.error("Firebase signInWithPhoneNumber failed", {
    domain: getCurrentDomain(),
    code: getSafeFirebaseErrorCode(error),
    provider: "firebase",
    stage,
    fallbackDecision: classifyFirebaseSendError(error).action,
  });
}

export async function sendFirebaseOtp(phone, containerId) {
  if (sendsInProgress.has(containerId)) {
    const error = new Error("An OTP send is already in progress for this verifier.");
    error.code = "OTP_REQUEST_IN_PROGRESS";
    throw error;
  }

  let clearAfterSend = false;
  let stage = "recaptcha-setup";

  try {
    const verifier = getOrCreateRecaptchaVerifier(containerId);
    sendsInProgress.add(containerId);
    // SDK rendering/reset failures after this boundary are not proven pre-send.
    stage = "send";
    return await signInWithPhoneNumber(auth, phone, verifier);
  } catch (error) {
    logOtpError(error, stage);
    clearAfterSend = true;
    throw error;
  } finally {
    sendsInProgress.delete(containerId);
    if (clearAfterSend || pendingClears.has(containerId)) {
      clearFirebaseRecaptcha(containerId);
    }
  }
}

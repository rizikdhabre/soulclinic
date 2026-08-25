import { RecaptchaVerifier, signInWithPhoneNumber } from "firebase/auth";
import { auth } from "./firebase";

const verifiers = new Map();
const sendsInProgress = new Set();
const pendingClears = new Set();

function getCurrentDomain() {
  if (typeof window === "undefined") return "server";
  return window.location.hostname;
}

function getSafeFirebaseErrorCode(error) {
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
    throw new Error(`#${containerId} was not found on the page.`);
  }

  if (!verifiers.has(containerId)) {
    let verifier;
    verifier = new RecaptchaVerifier(auth, containerId, {
      size: "invisible",
      "expired-callback": () => clearVerifier(containerId, verifier),
    });
    verifiers.set(containerId, verifier);
  }

  return verifiers.get(containerId);
}

function logOtpError(error) {
  console.error("Firebase signInWithPhoneNumber failed", {
    domain: getCurrentDomain(),
    code: getSafeFirebaseErrorCode(error),
  });
}

export async function sendFirebaseOtp(phone, containerId) {
  if (sendsInProgress.has(containerId)) {
    const error = new Error("An OTP send is already in progress for this verifier.");
    error.code = "OTP_REQUEST_IN_PROGRESS";
    throw error;
  }

  let clearAfterSend = false;

  try {
    const verifier = getOrCreateRecaptchaVerifier(containerId);
    sendsInProgress.add(containerId);
    return await signInWithPhoneNumber(auth, phone, verifier);
  } catch (error) {
    logOtpError(error);
    clearAfterSend = true;
    throw error;
  } finally {
    sendsInProgress.delete(containerId);
    if (clearAfterSend || pendingClears.has(containerId)) {
      clearFirebaseRecaptcha(containerId);
    }
  }
}

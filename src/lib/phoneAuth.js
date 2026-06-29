import { RecaptchaVerifier, signInWithPhoneNumber } from "firebase/auth";
import { auth } from "./firebase";

const RECAPTCHA_CONTAINER_ID = "recaptcha-container";
let recaptchaSendInProgress = false;
let recaptchaClearRequested = false;

function getCurrentDomain() {
  if (typeof window === "undefined") return "server";
  return window.location.hostname;
}

function getRecaptchaContainer() {
  if (typeof document === "undefined") return null;
  return document.getElementById(RECAPTCHA_CONTAINER_ID);
}

export function clearRecaptchaVerifier() {
  if (typeof window === "undefined") return;

  if (recaptchaSendInProgress) {
    recaptchaClearRequested = true;
    return;
  }

  recaptchaClearRequested = false;

  const verifier = window.recaptchaVerifier;

  try {
    if (verifier && typeof verifier.clear === "function") {
      verifier.clear();
    }
  } catch (error) {
    console.warn("Failed to clear Firebase reCAPTCHA verifier", error);
  } finally {
    window.recaptchaVerifier = null;
  }
}

function getOrCreateRecaptchaVerifier() {
  if (typeof window === "undefined") {
    throw new Error("Firebase phone OTP can only be sent from the browser.");
  }

  const container = getRecaptchaContainer();

  if (!container) {
    throw new Error(`#${RECAPTCHA_CONTAINER_ID} was not found on the page.`);
  }

  if (!window.recaptchaVerifier) {
    window.recaptchaVerifier = new RecaptchaVerifier(
      auth,
      RECAPTCHA_CONTAINER_ID,
      {
        size: "invisible",
        "expired-callback": () => {
          recaptchaClearRequested = true;

          if (!recaptchaSendInProgress) {
            clearRecaptchaVerifier();
          }
        },
      },
    );
  }

  return window.recaptchaVerifier;
}

function logOtpError(error, phone) {
  console.error(
    "Firebase signInWithPhoneNumber failed",
    {
      phone,
      domain: getCurrentDomain(),
      code: error?.code,
      message: error?.message,
      customData: error?.customData,
    },
    error,
  );
}

export async function sendOTP(phone) {
  let shouldClearVerifierAfterSend = false;

  try {
    console.debug("Firebase sendOTP started", {
      phone,
      domain: getCurrentDomain(),
    });

    const verifier = getOrCreateRecaptchaVerifier();

    recaptchaSendInProgress = true;
    return await signInWithPhoneNumber(auth, phone, verifier);
  } catch (error) {
    logOtpError(error, phone);
    shouldClearVerifierAfterSend = true;
    throw error;
  } finally {
    recaptchaSendInProgress = false;

    if (shouldClearVerifierAfterSend || recaptchaClearRequested) {
      recaptchaClearRequested = false;
      clearRecaptchaVerifier();
    }
  }
}

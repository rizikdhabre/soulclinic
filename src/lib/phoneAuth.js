import { RecaptchaVerifier, signInWithPhoneNumber } from "firebase/auth";
import { auth } from "./firebase";

const RECAPTCHA_CONTAINER_ID = "recaptcha-container";

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

  const verifier = window.recaptchaVerifier;

  try {
    if (verifier && typeof verifier.clear === "function") {
      verifier.clear();
    }
  } catch (error) {
    console.warn("Failed to clear Firebase reCAPTCHA verifier", error);
  } finally {
    window.recaptchaVerifier = null;

    const container = getRecaptchaContainer();
    if (container) {
      container.innerHTML = "";
    }
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
          clearRecaptchaVerifier();
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
  try {
    console.debug("Firebase sendOTP started", {
      phone,
      domain: getCurrentDomain(),
    });

    const verifier = getOrCreateRecaptchaVerifier();

    return await signInWithPhoneNumber(auth, phone, verifier);
  } catch (error) {
    logOtpError(error, phone);
    clearRecaptchaVerifier();
    throw error;
  }
}

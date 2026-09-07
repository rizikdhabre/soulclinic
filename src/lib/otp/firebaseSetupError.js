export const FIREBASE_RECAPTCHA_SETUP_FAILED = "otp/recaptcha-setup-failed";

// Construct only at a positively identified reCAPTCHA boundary before sending.
export class FirebaseRecaptchaSetupError extends Error {
  constructor() {
    super("Firebase reCAPTCHA setup failed before sending.");
    this.name = "FirebaseRecaptchaSetupError";
    this.code = FIREBASE_RECAPTCHA_SETUP_FAILED;
  }
}

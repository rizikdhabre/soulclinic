export class OtpError extends Error {
  constructor(code, status, message, retryAfterSeconds) {
    super(message);
    this.name = "OtpError";
    this.code = code;
    this.status = status;
    if (retryAfterSeconds) this.retryAfterSeconds = retryAfterSeconds;
  }
}

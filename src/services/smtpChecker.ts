import { smtpPool } from "./smtpPool.js";

export interface SMTPVerificationResult {
  success: boolean;
  smtpValid: boolean;
  mailboxExists: boolean;
  responseCode: number | null;
  responseMessage: string;
  transcript: string[];
  mxHost: string;
  durationMs: number;
}

export async function verifySMTP(
  email: string,
  mxHost: string
): Promise<SMTPVerificationResult> {
  const started = Date.now();

  const normalizedEmail =
    email.trim().toLowerCase();

  const normalizedMX =
    mxHost
      .trim()
      .toLowerCase()
      .replace(/\.$/, "");

  if (!normalizedEmail) {
    return {
      success: false,
      smtpValid: false,
      mailboxExists: false,
      responseCode: null,
      responseMessage: "Email is required",
      transcript: [
        "SMTP_VALIDATION_ERROR",
        "Email is required"
      ],
      mxHost: normalizedMX,
      durationMs:
        Date.now() - started
    };
  }

  if (!normalizedMX) {
    return {
      success: false,
      smtpValid: false,
      mailboxExists: false,
      responseCode: null,
      responseMessage: "MX host is required",
      transcript: [
        "SMTP_VALIDATION_ERROR",
        "MX host is required"
      ],
      mxHost: normalizedMX,
      durationMs:
        Date.now() - started
    };
  }

  try {
    const result =
      await smtpPool.verifyRecipient(
        normalizedMX,
        normalizedEmail
      );

    const responseCode =
      typeof result.code === "number"
        ? result.code
        : null;

    const responseMessage =
      typeof result.message === "string"
        ? result.message
        : "";

    const mailboxExists =
      responseCode === 250;

    const smtpValid =
      responseCode !== null &&
      responseCode >= 200 &&
      responseCode < 300;

    return {
      success: true,
      smtpValid,
      mailboxExists,
      responseCode,
      responseMessage,
      transcript: [
        "SMTP_POOL",
        `MX: ${normalizedMX}`,
        `RCPT RESPONSE: ${responseMessage}`
      ],
      mxHost: normalizedMX,
      durationMs:
        Date.now() - started
    };
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    return {
      success: false,
      smtpValid: false,
      mailboxExists: false,
      responseCode: null,
      responseMessage: message,
      transcript: [
        "SMTP_POOL_ERROR",
        message
      ],
      mxHost: normalizedMX,
      durationMs:
        Date.now() - started
    };
  }
}
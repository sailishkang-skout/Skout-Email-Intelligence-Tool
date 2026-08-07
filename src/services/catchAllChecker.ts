import { SMTPConnection } from "./smtpConnection.js";

export interface CatchAllResult {
  checked: boolean;
  isCatchAll: boolean;
  confidence:
    | "high"
    | "medium"
    | "low"
    | "unknown";
  testEmail: string | null;
  responseCode: number | null;
  responseMessage: string;
  mxHost: string;
  reason: string;
  durationMs: number;
}

function normalizeDomain(
  domain: string
): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    ?.trim() ?? "";
}

function generateCatchAllTestEmail(
  domain: string
): string {
  const normalizedDomain =
    normalizeDomain(domain);

  const token =
    `skout-catchall-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 12)}`;

  return `${token}@${normalizedDomain}`;
}

function classifyResponse(
  code: number | null
): {
  isCatchAll: boolean;
  confidence: CatchAllResult["confidence"];
  reason: string;
} {
  if (
    code !== null &&
    code >= 200 &&
    code < 300
  ) {
    return {
      isCatchAll: true,
      confidence: "high",
      reason:
        "SMTP server accepted a randomly generated recipient"
    };
  }

  if (
    code !== null &&
    code >= 500 &&
    code < 600
  ) {
    return {
      isCatchAll: false,
      confidence: "high",
      reason:
        "SMTP server rejected the randomly generated recipient"
    };
  }

  if (
    code !== null &&
    code >= 400 &&
    code < 500
  ) {
    return {
      isCatchAll: false,
      confidence: "low",
      reason:
        "SMTP server returned a temporary response; catch-all status is inconclusive"
    };
  }

  return {
    isCatchAll: false,
    confidence: "unknown",
    reason:
      "No definitive SMTP response was received"
  };
}

export async function checkCatchAll(
  email: string,
  mxHost: string
): Promise<CatchAllResult> {
  const startedAt = Date.now();

  const atIndex =
    email.lastIndexOf("@");

  if (
    atIndex <= 0 ||
    atIndex >= email.length - 1
  ) {
    return {
      checked: false,
      isCatchAll: false,
      confidence: "unknown",
      testEmail: null,
      responseCode: null,
      responseMessage:
        "Invalid email address",
      mxHost,
      reason:
        "Cannot determine domain from email address",
      durationMs:
        Date.now() - startedAt
    };
  }

  const domain =
    normalizeDomain(
      email.slice(atIndex + 1)
    );

  if (!domain) {
    return {
      checked: false,
      isCatchAll: false,
      confidence: "unknown",
      testEmail: null,
      responseCode: null,
      responseMessage:
        "Invalid email domain",
      mxHost,
      reason:
        "Cannot determine domain",
      durationMs:
        Date.now() - startedAt
    };
  }

  const testEmail =
    generateCatchAllTestEmail(
      domain
    );

  const connection =
    new SMTPConnection({
      host: mxHost,
      port: 25,
      timeoutMs: 10000,
      heloDomain: "skout.ai"
    });

  try {
    await connection.connect();

    const response =
      await connection.verifyRecipient(
        testEmail
      );

    const classification =
      classifyResponse(
        response.code
      );

    try {
      await connection.reset();
    } catch {
      // Ignore reset failures.
    }

    return {
      checked: true,
      isCatchAll:
        classification.isCatchAll,
      confidence:
        classification.confidence,
      testEmail,
      responseCode:
        response.code,
      responseMessage:
        response.message,
      mxHost,
      reason:
        classification.reason,
      durationMs:
        Date.now() - startedAt
    };
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    return {
      checked: false,
      isCatchAll: false,
      confidence: "unknown",
      testEmail,
      responseCode: null,
      responseMessage: message,
      mxHost,
      reason:
        "Catch-all verification could not be completed",
      durationMs:
        Date.now() - startedAt
    };
  } finally {
    try {
      await connection.close();
    } catch {
      // Ignore connection-close errors.
    }
  }
}
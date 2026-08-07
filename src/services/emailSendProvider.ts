/*
==================================================
EMAIL SEND PROVIDER
==================================================

Transport-only abstraction for outbound email.

Supported implementations:

    SMTP
    SES
    Resend
    SendGrid
    Mailgun
    Postmark
    Mock

Architecture:

OutboundEmailService
        ↓
EmailSendProvider
        ↓
Concrete Provider

IMPORTANT:

This layer MUST NOT:

    - verify email addresses
    - perform MX verification
    - perform SMTP mailbox verification
    - determine send eligibility
    - perform catch-all detection
    - perform lead scoring
    - make campaign decisions

==================================================
*/

export interface EmailSendRequest {

  from: string;

  to: string;

  subject: string;

  text?: string;

  html?: string;
}

/*
==================================================
EMAIL SEND RESULT
==================================================

accepted === true means the provider accepted
the message for submission.

It DOES NOT mean:

    - mailbox exists
    - mailbox is valid
    - message was delivered
    - recipient received it
    - recipient opened it
    - message will not bounce
==================================================
*/

export interface EmailSendResult {

  provider: string;

  messageId: string | null;

  accepted: boolean;

  response: string | null;
}

/*
==================================================
EMAIL SEND PROVIDER
==================================================
*/

export interface EmailSendProvider {

  send(
    request: EmailSendRequest
  ): Promise<EmailSendResult>;
}

/*
==================================================
PROVIDER ERROR
==================================================
*/

export interface EmailSendProviderErrorOptions {

  provider?: string;

  code?: string | null;

  response?: string | null;

  retryable?: boolean;
}

export class EmailSendProviderError
  extends Error {

  public readonly provider: string;

  public readonly code: string | null;

  public readonly response: string | null;

  public readonly retryable: boolean;

  constructor(
    message: string,
    options: EmailSendProviderErrorOptions = {}
  ) {

    super(message);

    this.name =
      "EmailSendProviderError";

    this.provider =
      options.provider ??
      "unknown";

    this.code =
      options.code ??
      null;

    this.response =
      options.response ??
      null;

    this.retryable =
      options.retryable ??
      false;

    Object.setPrototypeOf(
      this,
      new.target.prototype
    );
  }
}

/*
==================================================
PROVIDER ERROR TYPE GUARD
==================================================
*/

export function isEmailSendProviderError(
  error: unknown
): error is EmailSendProviderError {

  return (
    error instanceof
    EmailSendProviderError
  );
}

/*
==================================================
EMAIL SEND REQUEST TYPE GUARD
==================================================
*/

export function isEmailSendRequest(
  value: unknown
): value is EmailSendRequest {

  if (
    !value ||
    typeof value !== "object"
  ) {
    return false;
  }

  const request =
    value as Partial<EmailSendRequest>;

  if (
    typeof request.from !== "string" ||
    !request.from.trim()
  ) {
    return false;
  }

  if (
    typeof request.to !== "string" ||
    !request.to.trim()
  ) {
    return false;
  }

  if (
    typeof request.subject !== "string" ||
    !request.subject.trim()
  ) {
    return false;
  }

  if (
    request.text !== undefined &&
    typeof request.text !== "string"
  ) {
    return false;
  }

  if (
    request.html !== undefined &&
    typeof request.html !== "string"
  ) {
    return false;
  }

  /*
  At least one message body is required.
  */

  if (
    !request.text &&
    !request.html
  ) {
    return false;
  }

  return true;
}

/*
==================================================
EMAIL SEND RESULT TYPE GUARD
==================================================
*/

export function isEmailSendResult(
  value: unknown
): value is EmailSendResult {

  if (
    !value ||
    typeof value !== "object"
  ) {
    return false;
  }

  const result =
    value as Partial<EmailSendResult>;

  if (
    typeof result.provider !== "string" ||
    !result.provider.trim()
  ) {
    return false;
  }

  if (
    result.messageId !== null &&
    typeof result.messageId !== "string"
  ) {
    return false;
  }

  if (
    typeof result.accepted !== "boolean"
  ) {
    return false;
  }

  if (
    result.response !== null &&
    typeof result.response !== "string"
  ) {
    return false;
  }

  return true;
}
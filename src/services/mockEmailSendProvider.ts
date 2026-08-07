/*
==================================================
MOCK EMAIL SEND PROVIDER
==================================================

Purpose:

    - local development
    - integration testing
    - API testing
    - provider failure testing

This provider NEVER sends a real email.
==================================================
*/

import {
  EmailSendProviderError,
  type EmailSendProvider,
  type EmailSendRequest,
  type EmailSendResult,
} from "./emailSendProvider.js";

/*
==================================================
OPTIONS
==================================================
*/

export interface MockEmailSendProviderOptions {
  providerName?: string;

  shouldAccept?: boolean;

  failureMessage?: string;

  response?: string | null;
}

/*
==================================================
PROVIDER
==================================================
*/

export class MockEmailSendProvider
  implements EmailSendProvider {

  private readonly providerName: string;

  private readonly shouldAccept: boolean;

  private readonly failureMessage: string;

  private readonly response: string | null;

  constructor(
    options: MockEmailSendProviderOptions = {}
  ) {
    this.providerName =
      options.providerName ??
      "mock";

    this.shouldAccept =
      options.shouldAccept ??
      true;

    this.failureMessage =
      options.failureMessage ??
      "Mock email provider rejected the message.";

    this.response =
      options.response ??
      "250 2.0.0 OK";
  }

  async send(
    request: EmailSendRequest
  ): Promise<EmailSendResult> {

    /*
    ==============================================
    REQUEST VALIDATION
    ==============================================
    */

    if (
      !request ||
      typeof request !== "object"
    ) {
      throw new EmailSendProviderError(
        "Invalid email send request.",
        {
          provider:
            this.providerName,

          code:
            "INVALID_REQUEST",
        }
      );
    }

    if (
      typeof request.from !== "string" ||
      !request.from.trim()
    ) {
      throw new EmailSendProviderError(
        "Sender email address is required.",
        {
          provider:
            this.providerName,

          code:
            "INVALID_FROM_ADDRESS",
        }
      );
    }

    if (
      typeof request.to !== "string" ||
      !request.to.trim()
    ) {
      throw new EmailSendProviderError(
        "Recipient email address is required.",
        {
          provider:
            this.providerName,

          code:
            "INVALID_TO_ADDRESS",
        }
      );
    }

    if (
      typeof request.subject !== "string" ||
      !request.subject.trim()
    ) {
      throw new EmailSendProviderError(
        "Email subject is required.",
        {
          provider:
            this.providerName,

          code:
            "INVALID_SUBJECT",
        }
      );
    }

    /*
    ==============================================
    SIMULATED PROVIDER FAILURE
    ==============================================
    */

    if (
      !this.shouldAccept
    ) {
      throw new EmailSendProviderError(
        this.failureMessage,
        {
          provider:
            this.providerName,

          code:
            "PROVIDER_REJECTED",

          response:
            this.response,
        }
      );
    }

    /*
    ==============================================
    MESSAGE ID
    ==============================================
    */

    const messageId =
      `mock-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 10)}`;

    /*
    ==============================================
    ACCEPTED
    ==============================================
    */

    return {
      provider:
        this.providerName,

      messageId,

      accepted:
        true,

      response:
        this.response,
    };
  }
}

/*
==================================================
DEFAULT EXPORT
==================================================
*/

export default MockEmailSendProvider;
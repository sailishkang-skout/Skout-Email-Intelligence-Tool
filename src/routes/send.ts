/*
==================================================
SEND ROUTE
==================================================

POST /send

Purpose
-------

Accept an outbound email request and pass it
through the final outbound safety architecture.

Architecture:

    HTTP Request
         ↓
    Input Validation
         ↓
    Authoritative Verification Record
         ↓
    Outbound Email Service
         ↓
    Send Eligibility
         ↓
    Outbound Send Guard
         ↓
    Email Send Provider
         ↓
    Response

IMPORTANT:

The route itself does NOT:

    - verify email
    - perform DNS
    - perform MX
    - perform SMTP
    - determine catch-all
    - determine mailbox existence
    - authorize sending independently

The final authorization belongs to the
outbound send guard.

Production architecture should eventually use:

    verificationId
         ↓
    trusted persistence lookup
         ↓
    AuthoritativeVerificationRecord
         ↓
    OutboundEmailService
         ↓
    OutboundSendGuard
         ↓
    Provider

The client must NOT be trusted to manufacture:

    authoritative: true
==================================================
*/

import type {
  FastifyInstance,
} from "fastify";

import {
  sendOutboundEmail,
  isAuthoritativeVerificationRecord,
} from "../services/outboundEmailService.js";

import {
  MockEmailSendProvider,
} from "../services/mockEmailSendProvider.js";

/*
==================================================
REQUEST BODY
==================================================
*/

interface SendRequestBody {

  email?: unknown;

  from?: unknown;

  subject?: unknown;

  text?: unknown;

  html?: unknown;

  verification?: unknown;
}

/*
==================================================
EMAIL NORMALIZATION
==================================================
*/

function normalizeEmail(
  value: unknown
): string {

  if (
    typeof value !== "string"
  ) {
    return "";
  }

  return value
    .trim()
    .toLowerCase();
}

/*
==================================================
EMAIL FORMAT VALIDATION
==================================================

This validates only basic email syntax.

It does NOT determine:

    - mailbox existence
    - MX
    - SMTP
    - catch-all
    - deliverability
==================================================
*/

function isValidEmail(
  email: string
): boolean {

  if (
    !email ||
    email.length > 254
  ) {
    return false;
  }

  const atIndex =
    email.lastIndexOf("@");

  if (
    atIndex <= 0 ||
    atIndex !== email.indexOf("@")
  ) {
    return false;
  }

  const localPart =
    email.slice(
      0,
      atIndex
    );

  const domain =
    email.slice(
      atIndex + 1
    );

  if (
    !localPart ||
    !domain
  ) {
    return false;
  }

  if (
    localPart.length > 64 ||
    domain.length > 253
  ) {
    return false;
  }

  if (
    !domain.includes(".")
  ) {
    return false;
  }

  if (
    domain.startsWith(".") ||
    domain.endsWith(".") ||
    domain.includes("..")
  ) {
    return false;
  }

  if (
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(
      localPart
    )
  ) {
    return false;
  }

  if (
    !/^[a-z0-9.-]+$/i.test(
      domain
    )
  ) {
    return false;
  }

  return true;
}

/*
==================================================
OPTIONAL STRING
==================================================
*/

function optionalString(
  value: unknown
): string | undefined {

  if (
    typeof value !== "string"
  ) {
    return undefined;
  }

  const normalized =
    value.trim();

  return normalized.length > 0
    ? normalized
    : undefined;
}

/*
==================================================
HTTP STATUS
==================================================
*/

function getHttpStatus(
  result: {
    success: boolean;

    error: string | null;
  }
): number {

  /*
  Provider accepted the message.
  */

  if (
    result.success
  ) {
    return 200;
  }

  /*
  Caller supplied invalid data.
  */

  if (
    result.error &&
    (
      result.error.startsWith(
        "INVALID_"
      ) ||
      result.error ===
        "AUTHORITATIVE_VERIFICATION_REQUIRED" ||
      result.error ===
        "VERIFICATION_EMAIL_MISMATCH"
    )
  ) {
    return 400;
  }

  /*
  Policy/verification/provider prevented
  the send.

  The exact internal error remains inside
  the service result.
  */

  return 422;
}

/*
==================================================
ROUTE
==================================================
*/

export default async function sendRoutes(
  app: FastifyInstance
): Promise<void> {

  /*
  ==================================================
  MOCK PROVIDER
  ==================================================

  Development-only provider.

  Replace this with a concrete production
  provider adapter later.

  The provider is transport-only.

  It does NOT determine eligibility.
  */

  const provider =
    new MockEmailSendProvider();

  /*
  ==================================================
  POST /send
  ==================================================
  */

  app.post<{
    Body: SendRequestBody;
  }>(
    "/send",

    async (
      request,
      reply
    ) => {

      /*
      ==============================================
      1. REQUEST BODY
      ==============================================
      */

      const body =
        request.body ?? {};

      /*
      ==============================================
      2. RECIPIENT EMAIL
      ==============================================
      */

      const email =
        normalizeEmail(
          body.email
        );

      if (
        !email
      ) {

        return reply
          .code(400)
          .send({
            success: false,

            email: "",

            error:
              "email required",
          });
      }

      /*
      ==============================================
      3. EMAIL FORMAT
      ==============================================
      */

      if (
        !isValidEmail(
          email
        )
      ) {

        return reply
          .code(400)
          .send({
            success: false,

            email,

            error:
              "Invalid email address",
          });
      }

      /*
      ==============================================
      4. AUTHORITATIVE VERIFICATION
      ==============================================
      
      We require the complete authoritative
      verification record.

      We intentionally do NOT accept a raw
      VerificationStatusResult.

      The authoritative record contains:

          verificationId
          emailAddress
          verifiedAt
          expiresAt
          verifierVersion
          authoritative

      Production should eventually retrieve this
      from trusted persistence using verificationId.

      The client must NEVER be able to simply
      claim:

          authoritative: true
      ==============================================
      */

      if (
        !isAuthoritativeVerificationRecord(
          body.verification
        )
      ) {

        request.log.warn(
          {
            email,
          },
          "[SendRoute] Missing or invalid authoritative verification record"
        );

        return reply
          .code(400)
          .send({
            success: false,

            email,

            error:
              "verification must be a valid authoritative verification record",
          });
      }

      const verification =
        body.verification;

      /*
      ==============================================
      5. VERIFIED EMAIL CONSISTENCY
      ==============================================

      The verification record belongs to one
      specific email address.

      It must match the actual recipient.

      This prevents:

          verified person A
              ↓
          send to person B

      ==============================================
      */

      const verifiedEmail =
        normalizeEmail(
          verification.emailAddress
        );

      if (
        !verifiedEmail ||
        verifiedEmail !== email
      ) {

        request.log.warn(
          {
            email,

            verifiedEmail,

            verificationId:
              verification.verificationId,
          },
          "[SendRoute] Verification email does not match recipient"
        );

        return reply
          .code(400)
          .send({
            success: false,

            email,

            error:
              "verification emailAddress does not match email",
          });
      }

      /*
      ==============================================
      6. FROM
      ==============================================
      */

      const from =
        optionalString(
          body.from
        ) ??
        "test@skout.ai";

      /*
      ==============================================
      7. SUBJECT
      ==============================================
      */

      const subject =
        optionalString(
          body.subject
        ) ??
        "Skout test email";

      /*
      ==============================================
      8. TEXT
      ==============================================
      */

      const text =
        optionalString(
          body.text
        );

      /*
      ==============================================
      9. HTML
      ==============================================
      */

      const html =
        optionalString(
          body.html
        );

      /*
      ==============================================
      10. MESSAGE BODY VALIDATION
      ==============================================
      */

      if (
        text === undefined &&
        html === undefined
      ) {

        return reply
          .code(400)
          .send({
            success: false,

            email,

            error:
              "At least one of text or html is required",
          });
      }

      /*
      ==============================================
      11. REQUEST LOGGING
      ==============================================

      Do NOT log:

          email body
          message content
          provider credentials
          sensitive provider responses

      The verification metadata is useful for
      policy observability.
      ==============================================
      */

      request.log.info(
        {
          email,

          verificationId:
            verification.verificationId,

          verificationStatus:
            verification.status,

          verificationPassed:
            verification.verificationPassed,

          mailboxVerified:
            verification.mailboxVerified,

          retryable:
            verification.retryable,

          authoritative:
            verification.authoritative,

          verifiedAt:
            verification.verifiedAt,

          expiresAt:
            verification.expiresAt,

          verifierVersion:
            verification.verifierVersion,
        },
        "[SendRoute] Evaluating outbound send"
      );

      /*
      ==============================================
      12. OUTBOUND EMAIL SERVICE
      ==============================================

      The service is responsible for enforcing
      the outbound send boundary.

      The provider must only be reached after:

          authoritative verification
              +
          recipient consistency
              +
          send eligibility
              +
          outbound send guard

      The provider itself remains transport-only.
      ==============================================
      */

      let result;

      try {

        result =
          await sendOutboundEmail(
            provider,

            {
              from,

              to:
                email,

              subject,

              ...(text !== undefined
                ? {
                    text,
                  }
                : {}),

              ...(html !== undefined
                ? {
                    html,
                  }
                : {}),

              verification,
            }
          );

      } catch (
        error: unknown
      ) {

        const message =
          error instanceof Error
            ? error.message
            : String(error);

        request.log.error(
          {
            error:
              message,

            email,

            verificationId:
              verification.verificationId,
          },
          "[SendRoute] Outbound email service failed"
        );

        return reply
          .code(500)
          .send({
            success: false,

            email,

            error:
              "Outbound email service failed",
          });
      }

      /*
      ==============================================
      13. HTTP STATUS
      ==============================================
      */

      const httpStatus =
        getHttpStatus(
          result
        );

      /*
      ==============================================
      14. RESPONSE
      ==============================================
      */

      return reply
        .code(httpStatus)
        .send({
          success:
            result.success,

          email,

          outbound:
            result,
        });
    }
  );
}
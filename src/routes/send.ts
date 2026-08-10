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
} from "../services/outboundEmailService.js";

import {
  MockEmailSendProvider,
} from "../services/mockEmailSendProvider.js";

import {
  VerificationRepository,
} from "../repositories/verificationRepository.js";

import {
  buildVerificationStatus,
} from "../services/verificationStatus.js";

import { extractErrorMessage } from "../utils/errorMessage.js";

import {
  runIdempotent,
  IdempotencyInProgressError,
  IdempotencyUnavailableError,
} from "../redis/idempotency.js";

import {
  createAuthoritativeVerificationRecord,
  type AuthoritativeVerificationRecord,
} from "../services/sendEligibility.js";

/*
==================================================
VERIFICATION FRESHNESS
==================================================

How long a persisted verification result remains
usable to authorize an outbound send. Configurable
so operators can tighten/loosen this without a code
change.
==================================================
*/

const VERIFICATION_TTL_MS =
  (
    Number(
      process.env.VERIFICATION_TTL_DAYS
    ) || 30
  ) *
  24 *
  60 *
  60 *
  1000;

const verificationRepository =
  new VerificationRepository();

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

  verificationId?: unknown;
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

      CRITICAL SECURITY BOUNDARY:

      The route must NEVER accept a verification
      record (or the `authoritative` flag) directly
      from the request body. A caller could otherwise
      simply assert:

          authoritative: true
          status: "VERIFIED"

      and bypass the entire verification pipeline.

      Instead the caller supplies only a
      verificationId, and the server looks up the
      trusted, persisted verification result and
      reconstructs the authoritative record from it.
      ==============================================
      */

      const verificationId =
        optionalString(
          body.verificationId
        );

      if (
        !verificationId
      ) {

        return reply
          .code(400)
          .send({
            success: false,

            email,

            error:
              "verificationId is required",
          });
      }

      let persistedVerification;

      try {

        persistedVerification =
          await verificationRepository.findByVerificationId(
            verificationId
          );

      } catch (
        error: unknown
      ) {

        const message =
          extractErrorMessage(error);

        request.log.error(
          {
            error: message,

            email,

            verificationId,
          },
          "[SendRoute] Verification lookup failed"
        );

        return reply
          .code(500)
          .send({
            success: false,

            email,

            error:
              "Verification lookup failed",
          });
      }

      if (
        !persistedVerification
      ) {

        request.log.warn(
          {
            email,

            verificationId,
          },
          "[SendRoute] No persisted verification found for verificationId"
        );

        return reply
          .code(400)
          .send({
            success: false,

            email,

            error:
              "No verification result was found for the supplied verificationId",
          });
      }

      /*
      ==============================================
      5. VERIFIED EMAIL CONSISTENCY
      ==============================================

      The persisted verification record belongs to
      one specific email address. It must match the
      actual recipient. This prevents:

          verified person A
              ↓
          send to person B

      ==============================================
      */

      const verifiedEmail =
        normalizeEmail(
          persistedVerification.email
        );

      if (
        !verifiedEmail ||
        verifiedEmail !== email
      ) {

        request.log.warn(
          {
            email,

            verifiedEmail,

            verificationId,
          },
          "[SendRoute] Verification email does not match recipient"
        );

        return reply
          .code(400)
          .send({
            success: false,

            email,

            error:
              "verification does not belong to the recipient email address",
          });
      }

      /*
      ==============================================
      5b. RECONSTRUCT AUTHORITATIVE RECORD
      ==============================================

      Rebuild the canonical VerificationStatusResult
      from the persisted, server-produced evidence
      (never from client input), then mint the
      authoritative record server-side.
      ==============================================
      */

      const verificationStatus =
        buildVerificationStatus({

          mxAvailable:
            persistedVerification.mx_available ?? false,

          responseCode:
            persistedVerification.response_code,

          responseMessage:
            persistedVerification.response_message,

          mailboxExists:
            persistedVerification.mailbox_exists ?? false,

          smtpValid:
            persistedVerification.smtp_valid ?? false,

          catchAll:
            persistedVerification.catch_all ?? false,

          retryRequired:
            persistedVerification.retry_required ?? false,

          retryReason:
            persistedVerification.retry_reason,
        });

      const verifiedAt =
        persistedVerification.updated_at;

      const expiresAt =
        new Date(
          new Date(verifiedAt).getTime() +
            VERIFICATION_TTL_MS
        ).toISOString();

      const verification: AuthoritativeVerificationRecord =
        createAuthoritativeVerificationRecord(
          verificationStatus,
          {
            verificationId:
              persistedVerification.verification_id,

            emailAddress:
              persistedVerification.email,

            verifiedAt,

            expiresAt,

            verifierVersion:
              "verification-engine-v1",
          }
        );

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

        /*
        A verificationId authorizes exactly one outbound send. Without
        this, replaying the same request (a client retry, or two
        concurrent requests) triggers a separate real send through the
        provider each time - confirmed live: three concurrent /send
        calls with an identical verificationId produced three distinct
        provider messageIds. Keying on verificationId alone (rather
        than the full payload) means a second attempt - whatever its
        outcome - is answered from the first attempt's cached result
        instead of re-invoking the provider.
        */

        result =
          await runIdempotent(
            `send:${verification.verificationId}`,
            () =>
              sendOutboundEmail(
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
              )
          );

      } catch (
        error: unknown
      ) {

        if (
          error instanceof IdempotencyInProgressError
        ) {

          return reply
            .code(409)
            .send({
              success: false,

              email,

              error:
                "A send for this verificationId is already in progress",
            });

        }

        /*
        The idempotency store itself (Redis) could not be reached to
        even ESTABLISH a claim - critically, this is caught before
        sendOutboundEmail() ever runs (see runIdempotent() in
        idempotency.ts: it awaits the claim before calling the
        operation), so no email has been sent. The correct response
        here is a fast, truthful, fail-CLOSED rejection - never a
        hang, and never proceeding without the safety guarantee this
        route depends on.
        */
        if (
          error instanceof IdempotencyUnavailableError
        ) {

          request.log.error(
            {
              error:
                extractErrorMessage(error),

              email,

              verificationId:
                verification.verificationId,
            },
            "[SendRoute] Idempotency check unavailable - refusing to send"
          );

          return reply
            .code(503)
            .send({
              success: false,

              email,

              error:
                "Cannot verify this send has not already occurred - safety check temporarily unavailable, no email was sent",
            });

        }

        const message =
          extractErrorMessage(error);

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
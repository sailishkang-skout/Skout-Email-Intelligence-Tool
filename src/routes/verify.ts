import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import mailchecker from "mailchecker";

import { verifyEmail } from "../services/emailVerificationOrchestrator.js";

import { extractErrorMessage } from "../utils/errorMessage.js";

import {
  buildVerificationStatus,
  classifyVerificationErrorType,
  type VerificationStatusResult,
} from "../services/verificationStatus.js";

import {
  evaluateSendEligibility,
  SEND_ELIGIBILITY_POLICY_VERSION,
  type SendEligibilityResult,
  type AuthoritativeVerificationRecord,
} from "../services/sendEligibility.js";

import {
  VerificationRepository
} from "../repositories/verificationRepository.js";

/*
==================================================
VERIFY ROUTE
==================================================

POST /verify

Pipeline:

    HTTP Request
         ↓
    Input Validation
         ↓
    Email Normalization
         ↓
    Disposable Detection
         ↓
    Email Verification Orchestrator
         ↓
    Canonical Verification Status
         ↓
    Authoritative Verification Record
         ↓
    Send Eligibility
         ↓
    HTTP Response

Responsibilities:

    Route
      - HTTP concerns
      - input validation
      - normalization
      - response formatting
      - construction of the trusted server-side
        verification record used by send policy

    emailVerificationOrchestrator
      - MX
      - SMTP
      - mailbox verification
      - catch-all
      - retry state
      - verification evidence

    verificationStatus
      - canonical verification classification

    sendEligibility
      - outbound sending policy

IMPORTANT:

SendEligibilityInput requires:

    {
      verification: AuthoritativeVerificationRecord
    }

The route therefore converts the trusted verifier
result into the authoritative record before calling
the policy engine.

The client never controls:

    authoritative
    verificationId
    verifiedAt
    expiresAt
    verifierVersion
==================================================
*/

const verificationRepository =
  new VerificationRepository();

/*
==================================================
REQUEST TYPES
==================================================
*/

interface VerifyRequestBody {
  email?: unknown;
  pattern?: unknown;
  requestId?: unknown;
}

/*
==================================================
RESPONSE TYPES
==================================================
*/

interface VerifyErrorResponse {
  success: false;
  email: string;
  domain: string | null;
  disposable: boolean;
  error: string;
}

/*
==================================================
EMAIL NORMALIZATION
==================================================
*/

function normalizeEmail(
  value: string
): string {
  return value
    .trim()
    .toLowerCase();
}

/*
==================================================
DOMAIN EXTRACTION
==================================================
*/

function extractDomain(
  email: string
): string | null {
  const atIndex =
    email.lastIndexOf("@");

  if (
    atIndex <= 0 ||
    atIndex >= email.length - 1
  ) {
    return null;
  }

  const domain =
    email
      .slice(atIndex + 1)
      .trim()
      .toLowerCase();

  if (!domain) {
    return null;
  }

  return domain;
}

/*
==================================================
DOMAIN NORMALIZATION
==================================================
*/

function normalizeDomain(
  domain: string
): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(
      /^https?:\/\//,
      ""
    )
    .replace(
      /^www\./,
      ""
    )
    .split("/")[0]
    ?.trim() ?? "";
}

/*
==================================================
EMAIL STRUCTURAL VALIDATION
==================================================

This is intentionally lightweight.

It does NOT determine whether the mailbox exists.

That belongs to the verification orchestrator.
==================================================
*/

function isStructurallyValidEmail(
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
DISPOSABLE EMAIL DETECTION
==================================================
*/

function isDisposableEmail(
  email: string
): boolean {
  try {
    /*
    mailchecker's isValid() returns false for
    disposable/blacklisted addresses (and for
    syntactically invalid ones, which is already
    handled separately above). A disposable email
    is therefore one that mailchecker rejects.
    */

    return !mailchecker.isValid(
      email
    );
  } catch (
    error: unknown
  ) {
    console.error(
      "[VerifyRoute] Disposable email check failed:",
      error
    );

    /*
    Disposable detection is supplementary.

    Failure here must not make the entire
    verification endpoint unavailable.
    */

    return false;
  }
}

/*
==================================================
SAFE OPTIONAL STRING
==================================================
*/

function optionalString(
  value: unknown
): string | null {
  if (
    typeof value !== "string"
  ) {
    return null;
  }

  const normalized =
    value.trim();

  return normalized
    ? normalized
    : null;
}

/*
==================================================
REQUEST ID
==================================================
*/

function getRequestId(
  request: FastifyRequest,
  body: VerifyRequestBody
): string | null {
  const explicit =
    optionalString(
      body.requestId
    );

  if (explicit) {
    return explicit;
  }

  if (
    typeof request.id === "string" &&
    request.id.trim()
  ) {
    return request.id.trim();
  }

  return null;
}

/*
==================================================
BUILD VERIFICATION STATUS INPUT
==================================================
*/

function buildStatusInput(
  result: Awaited<
    ReturnType<typeof verifyEmail>
  >
) {
  const errorType =
    classifyVerificationErrorType(
      result.error
    );

  return {
    mxAvailable:
      result.smtp.mxAvailable,

    mxHosts:
      result.smtp.mxHosts,

    primaryMX:
      result.smtp.primaryMX,

    responseCode:
      result.smtp.responseCode,

    responseMessage:
      result.smtp.responseMessage,

    mailboxExists:
      result.smtp.mailboxExists,

    smtpValid:
      result.smtp.smtpValid,

    catchAll:
      result.catchAll,

    retryRequired:
      result.retryRequired,

    retryReason:
      result.retryReason,

    error:
      result.error,

    errorType,
  };
}

/*
==================================================
AUTHORITATIVE VERIFICATION RECORD
==================================================

This is the bridge between:

    VerificationStatusResult

and:

    SendEligibilityInput

The send policy intentionally does NOT accept a
raw verification result.

The route creates the server-trusted record.

IMPORTANT:

`authoritative: true` is valid here because this
record is constructed entirely from the trusted
server-side verification orchestrator.

The client does not supply this value.
==================================================
*/

function buildAuthoritativeVerificationRecord(
  email: string,
  verificationStatus: VerificationStatusResult,
  result: Awaited<
    ReturnType<typeof verifyEmail>
  >
): AuthoritativeVerificationRecord {
  const verificationId =
    optionalString(
      result.verificationId
    );

  if (!verificationId) {
    throw new Error(
      "Verification result did not contain a verificationId."
    );
  }

  /*
  Prefer verifier-provided timestamps when they
  exist. Otherwise use the current server time.

  We intentionally do NOT allow request-body values
  to control these fields.
  */

  const resultWithMetadata =
    result as Awaited<
      ReturnType<typeof verifyEmail>
    > & {
      verifiedAt?: unknown;
      expiresAt?: unknown;
      verifierVersion?: unknown;
    };

  const verifiedAt =
    optionalString(
      resultWithMetadata.verifiedAt
    ) ??
    new Date().toISOString();

  const expiresAtValue =
    resultWithMetadata.expiresAt;

  const expiresAt =
    expiresAtValue === null
      ? null
      : optionalString(
          expiresAtValue
        );

  const verifierVersion =
    optionalString(
      resultWithMetadata.verifierVersion
    ) ??
    "1.0.0";

  return {
    ...verificationStatus,

    verificationId,

    emailAddress:
      email,

    verifiedAt,

    expiresAt,

    verifierVersion,

    authoritative:
      true,
  };
}

/*
==================================================
HTTP STATUS
==================================================

Verification verdicts are normally successful
HTTP operations.

For example:

    INVALID
    NO_MX
    CATCH_ALL
    TEMPORARY

are valid verification outcomes.

Only malformed requests or actual internal
failures return 4xx/5xx.
==================================================
*/

function getVerificationHttpStatus(
  status: VerificationStatusResult
): number {
  switch (
    status.status
  ) {
    case "VERIFIED":
    case "INVALID":
    case "CATCH_ALL":
    case "TEMPORARY":
    case "NO_MX":
    case "DNS_ERROR":
    case "SMTP_ERROR":
    case "UNKNOWN":
      return 200;

    default:
      return 200;
  }
}

/*
==================================================
MAIN ROUTE
==================================================
*/

export async function verifyRoute(
  app: FastifyInstance
): Promise<void> {
  app.post(
    "/verify",
    async (
      request: FastifyRequest<{
        Body: VerifyRequestBody;
      }>,
      reply: FastifyReply
    ) => {
      /*
      ==================================================
      1. REQUEST BODY
      ==================================================
      */

      const body =
        request.body ?? {};

      /*
      ==================================================
      2. EMAIL
      ==================================================
      */

      if (
        typeof body.email !== "string"
      ) {
        const response:
          VerifyErrorResponse = {
          success: false,
          email: "",
          domain: null,
          disposable: false,
          error:
            "email is required",
        };

        return reply
          .code(400)
          .send(response);
      }

      /*
      ==================================================
      3. NORMALIZE EMAIL
      ==================================================
      */

      const email =
        normalizeEmail(
          body.email
        );

      /*
      ==================================================
      4. STRUCTURAL VALIDATION
      ==================================================
      */

      if (
        !isStructurallyValidEmail(
          email
        )
      ) {
        const domain =
          extractDomain(
            email
          );

        const response:
          VerifyErrorResponse = {
          success: false,
          email,
          domain,
          disposable: false,
          error:
            "Invalid email address",
        };

        return reply
          .code(400)
          .send(response);
      }

      /*
      ==================================================
      5. DOMAIN
      ==================================================
      */

      const extractedDomain =
        extractDomain(
          email
        );

      if (
        !extractedDomain
      ) {
        const response:
          VerifyErrorResponse = {
          success: false,
          email,
          domain: null,
          disposable: false,
          error:
            "Unable to determine email domain",
        };

        return reply
          .code(400)
          .send(response);
      }

      const domain =
        normalizeDomain(
          extractedDomain
        );

      if (!domain) {
        const response:
          VerifyErrorResponse = {
          success: false,
          email,
          domain: null,
          disposable: false,
          error:
            "Unable to determine email domain",
        };

        return reply
          .code(400)
          .send(response);
      }

      /*
      ==================================================
      6. REQUEST ID
      ==================================================
      */

      const requestId =
        getRequestId(
          request,
          body
        );

      /*
      ==================================================
      7. PATTERN
      ==================================================
      */

      const pattern =
        optionalString(
          body.pattern
        );

      /*
      ==================================================
      8. DISPOSABLE
      ==================================================
      */

      const disposable =
        isDisposableEmail(
          email
        );

      /*
      ==================================================
      9. VERIFICATION ORCHESTRATOR
      ==================================================
      */

      let result:
        Awaited<
          ReturnType<typeof verifyEmail>
        >;

      try {
        result =
          await verifyEmail(
            email,
            {
              requestId,
              pattern,
            }
          );
      } catch (
        error: unknown
      ) {
        const message =
          extractErrorMessage(error);

        request.log.error(
          {
            error:
              message,

            email,

            domain,

            requestId,
          },
          "[VerifyRoute] Verification orchestrator failed"
        );

        const response:
          VerifyErrorResponse = {
          success: false,
          email,
          domain,
          disposable,
          error:
            message,
        };

        return reply
          .code(500)
          .send(response);
      }

      /*
      ==================================================
      10. CANONICAL VERIFICATION STATUS
      ==================================================
      */

      let verificationStatus:
        VerificationStatusResult;

      try {
        verificationStatus =
          buildVerificationStatus(
            buildStatusInput(
              result
            )
          );
      } catch (
        error: unknown
      ) {
        const message =
          extractErrorMessage(error);

        request.log.error(
          {
            error:
              message,

            email,

            domain,

            verificationId:
              result.verificationId,

            requestId,
          },
          "[VerifyRoute] Failed to build verification status"
        );

        return reply
          .code(500)
          .send({
            success: false,

            email,

            domain,

            verificationId:
              result.verificationId,

            requestId,

            disposable,

            error:
              "Unable to determine verification status",
          });
      }

      /*
      ==================================================
      11. BUILD AUTHORITATIVE RECORD
      ==================================================

      This is the important fix.

      Previously:

          VerificationStatusResult
                    ↓
          evaluateSendEligibility()

      That violated the new policy contract.

      Now:

          VerificationStatusResult
                    ↓
          AuthoritativeVerificationRecord
                    ↓
          evaluateSendEligibility()
      ==================================================
      */

      let authoritativeVerification:
        AuthoritativeVerificationRecord;

      try {
        authoritativeVerification =
          buildAuthoritativeVerificationRecord(
            email,
            verificationStatus,
            result
          );
      } catch (
        error: unknown
      ) {
        const message =
          extractErrorMessage(error);

        request.log.error(
          {
            error:
              message,

            email,

            domain,

            verificationId:
              result.verificationId,

            requestId,
          },
          "[VerifyRoute] Failed to construct authoritative verification record"
        );

        return reply
          .code(500)
          .send({
            success: false,

            email,

            domain,

            verificationId:
              result.verificationId,

            requestId,

            disposable,

            error:
              "Unable to construct authoritative verification record",
          });
      }

      /*
      ==================================================
      12. SEND ELIGIBILITY
      ==================================================

      IMPORTANT:

      The policy receives ONLY:

          {
            verification:
              authoritativeVerification
          }

      It does NOT receive:

          email
          domain
          request
          provider
          SMTP data
      ==================================================
      */

      let sendEligibility:
        SendEligibilityResult;

      try {
        sendEligibility =
          evaluateSendEligibility({
            verification:
              authoritativeVerification,

            now:
              new Date(),
          });
      } catch (
        error: unknown
      ) {
        const message =
          extractErrorMessage(error);

        request.log.error(
          {
            error:
              message,

            email,

            domain,

            verificationId:
              result.verificationId,

            requestId,
          },
          "[VerifyRoute] Send eligibility evaluation failed"
        );

        /*
        Safe fallback.

        This MUST match SendEligibilityResult
        exactly.

        In particular:

            decisionConfidence

        NOT:

            confidence
        */

        sendEligibility = {
          allowed: false,

          decision:
            "MANUAL_REVIEW",

          reasonCode:
            "INVALID_POLICY_INPUT",

          reason:
            "Send eligibility could not be determined.",

          decisionConfidence:
            0,

          verificationStatus:
            verificationStatus.status,

          retryable:
            false,

          manualReviewRequired:
            true,

          policyVersion:
            SEND_ELIGIBILITY_POLICY_VERSION,

          verificationId:
            result.verificationId ??
            null,
        };
      }

      /*
      ==================================================
      13. FINAL RESPONSE
      ==================================================
      */

      const response = {
        success:
          result.success,

        email,

        domain,

        verificationId:
          result.verificationId,

        requestId,

        /*
        ----------------------------------------------
        Canonical verification
        ----------------------------------------------
        */

        verificationStatus,

        /*
        ----------------------------------------------
        Authoritative verification metadata
        ----------------------------------------------
        */

        verificationRecord: {
          verificationId:
            authoritativeVerification.verificationId,

          emailAddress:
            authoritativeVerification.emailAddress,

          verifiedAt:
            authoritativeVerification.verifiedAt,

          expiresAt:
            authoritativeVerification.expiresAt,

          verifierVersion:
            authoritativeVerification.verifierVersion,

          authoritative:
            authoritativeVerification.authoritative,
        },

        /*
        ----------------------------------------------
        SMTP / MX evidence
        ----------------------------------------------
        */

        smtp: {
          responseCode:
            result.smtp.responseCode,

          responseMessage:
            result.smtp.responseMessage,

          mailboxExists:
            result.smtp.mailboxExists,

          smtpValid:
            result.smtp.smtpValid,

          mxAvailable:
            result.smtp.mxAvailable,

          mxHosts:
            result.smtp.mxHosts,

          primaryMX:
            result.smtp.primaryMX,

          provider:
            result.smtp.provider,
        },

        /*
        ----------------------------------------------
        Catch-all
        ----------------------------------------------
        */

        catchAll:
          result.catchAll,

        retryRequired:
          result.retryRequired,

        retryReason:
          result.retryReason,

        /*
        ----------------------------------------------
        Pattern
        ----------------------------------------------
        */

        pattern:
          result.pattern,

        patternEvidence:
          result.patternEvidence,

        /*
        ----------------------------------------------
        Intelligence
        ----------------------------------------------
        */

        intelligence:
          result.intelligence,

        /*
        ----------------------------------------------
        Disposable
        ----------------------------------------------
        */

        disposable,

        /*
        ----------------------------------------------
        Send policy
        ----------------------------------------------
        */

        sendEligibility,

        /*
        ----------------------------------------------
        Raw verification error
        ----------------------------------------------
        */

        error:
          result.error,
      };

      /*
      ==================================================
      14. HTTP RESPONSE
      ==================================================
      */

      const httpStatus =
        getVerificationHttpStatus(
          verificationStatus
        );

      return reply
        .code(httpStatus)
        .send(response);
    }
  );

  /*
  ==================================================
  GET VERIFICATION RESULT
  ==================================================

  GET /verification/:verificationId

  Reads persisted verification intelligence.

  ==================================================
  */

  app.get(
    "/verification/:verificationId",
    async (
      request: FastifyRequest<{
        Params:{
          verificationId:string;
        };
      }>,
      reply:FastifyReply
    )=>{


      const {
        verificationId
      } = request.params;


      let result;

      try {

        result =
          await verificationRepository.findByVerificationId(
            verificationId
          );

      } catch (
        error: unknown
      ) {

        request.log.error(
          {
            error: extractErrorMessage(error),

            verificationId,
          },
          "[VerifyRoute] Verification lookup failed"
        );

        return reply
          .code(500)
          .send({
            success: false,

            error:
              "Verification lookup failed",
          });
      }


      if(!result){

        return reply
          .code(404)
          .send({

            success:false,

            error:
              "Verification not found"

          });

      }


      return reply.send({

        success:true,

        verification:result

      });


    }
  );
}

/*
==================================================
DEFAULT EXPORT
==================================================
*/

export default verifyRoute;
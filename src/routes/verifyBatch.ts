import type { FastifyInstance } from "fastify";

import { verifyBatch } from "../services/batchVerification.js";

import {
  createVerificationJob,
  getVerificationJob,
  listVerificationJobItems,
  type VerificationJob,
} from "../services/verificationJobService.js";

import { config } from "../config/config.js";

import { extractErrorMessage } from "../utils/errorMessage.js";


/*
==================================================
TYPES
==================================================
*/

interface BatchRequestBody {

  emails?: string[];

}


/*
==================================================
ROUTE
==================================================

Delegates to the canonical batchVerification service,
which bounds SMTP concurrency and retries transient
failures. This route owns only HTTP concerns.
==================================================
*/

const MAX_BATCH_SIZE = config.verification.maxBatchSize;

function validateEmailsBody(
  body: BatchRequestBody
):
  | { valid: true; emails: string[] }
  | { valid: false; error: string; status: number } {

  const emails = body.emails;

  if (!Array.isArray(emails)) {
    return {
      valid: false,
      error: "emails array required",
      status: 400,
    };
  }

  if (emails.length > MAX_BATCH_SIZE) {
    return {
      valid: false,
      error: `Maximum batch size is ${MAX_BATCH_SIZE}`,
      status: 400,
    };
  }

  return { valid: true, emails };

}

export default async function verifyBatchRoutes(
  app: FastifyInstance
) {

  /*
  ==================================================
  POST /verify/batch — synchronous
  ==================================================

  Caller waits for all results in the HTTP response.
  Bounded batch size, concurrency-limited SMTP.
  ==================================================
  */

  app.post(
    "/verify/batch",
    async (
      request,
      reply
    ) => {

      const body =
        request.body as BatchRequestBody;

      const validation =
        validateEmailsBody(body);

      if (!validation.valid) {
        return reply.code(validation.status).send({
          success: false,
          error: validation.error,
        });
      }

      const { emails } = validation;

      if (emails.length === 0) {

        return {

          success: true,

          count: 0,

          results: []

        };

      }


      const { total, results } =
        await verifyBatch({
          emails
        });


      return {

        success: true,

        count: total,

        results

      };

    }
  );

  /*
  ==================================================
  POST /verify/batch/async — durable/queued
  ==================================================

  Creates a durable job record and returns as soon as
  that Postgres transaction commits - it does NOT wait
  on, or depend on, Redis/BullMQ being reachable. Each
  item is written together with a transactional outbox
  row in the same commit (see createVerificationJob),
  which a separate background dispatcher (see
  src/queue/outboxDispatcher.ts, started from
  src/worker.ts) polls and enqueues into BullMQ,
  retrying with backoff if Redis is down. The response
  here is therefore always truthful about what actually
  happened ("durably accepted"), never a false failure
  caused by a downstream dependency that hasn't been
  touched yet - use GET /verify/jobs/:jobId to observe
  real progress from PENDING through to
  COMPLETED/FAILED.
  ==================================================
  */

  app.post(
    "/verify/batch/async",
    async (
      request,
      reply
    ) => {

      const body =
        request.body as BatchRequestBody;

      const validation =
        validateEmailsBody(body);

      if (!validation.valid) {
        return reply.code(validation.status).send({
          success: false,
          error: validation.error,
        });
      }

      const { emails } = validation;

      if (emails.length === 0) {
        return reply.code(400).send({
          success: false,
          error: "emails array must not be empty",
        });
      }

      let job: VerificationJob;

      try {

        job =
          await createVerificationJob(emails);

      } catch (
        error: unknown
      ) {

        request.log.error(
          {
            error: extractErrorMessage(error),
          },
          "[VerifyBatchRoute] Failed to create verification job"
        );

        return reply
          .code(500)
          .send({
            success: false,

            error:
              "Failed to create verification job",
          });
      }

      return reply.code(202).send({

        success: true,

        jobId: job.jobId,

        total: job.total,

        status: job.status,

        statusUrl: `/verify/jobs/${job.jobId}`,

      });

    }
  );

  /*
  ==================================================
  GET /verify/jobs/:jobId
  ==================================================
  */

  app.get<{
    Params: { jobId: string };
  }>(
    "/verify/jobs/:jobId",
    async (
      request,
      reply
    ) => {

      let job;
      let items;

      try {

        job =
          await getVerificationJob(
            request.params.jobId
          );

        if (!job) {
          return reply.code(404).send({
            success: false,
            error: "Job not found",
          });
        }

        items =
          await listVerificationJobItems(job.id);

      } catch (
        error: unknown
      ) {

        request.log.error(
          {
            error: extractErrorMessage(error),

            jobId: request.params.jobId,
          },
          "[VerifyBatchRoute] Job lookup failed"
        );

        return reply
          .code(500)
          .send({
            success: false,

            error:
              "Job lookup failed",
          });
      }

      return {

        success: true,

        job,

        items,

      };

    }
  );

}

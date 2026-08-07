import type {
  FastifyInstance,
  FastifyPluginAsync
} from "fastify";

import {
  appendEvidence,
  getEvidenceByEmail,
  getEvidenceByVerificationId,
  type EvidenceLedgerInput,
  type EvidenceSource,
  type EvidenceOutcome
} from "../services/evidenceLedger.js";

interface EvidenceLedgerBody
  extends Partial<EvidenceLedgerInput> {

  email: string;

  source: EvidenceSource;

  outcome: EvidenceOutcome;

}

const evidenceLedgerRoutes:
  FastifyPluginAsync =
  async (
    app: FastifyInstance
  ) => {

    /*
    ==============================================
    POST /evidence
    ==============================================
    */

    app.post<{
      Body: EvidenceLedgerBody;
    }>(
      "/evidence",
      async (
        request,
        reply
      ) => {

        try {

          const body =
            request.body;

          if (
            !body ||
            typeof body !== "object"
          ) {

            return reply
              .code(400)
              .send({
                success: false,
                error:
                  "Request body is required"
              });

          }

          if (
            typeof body.email !== "string" ||
            !body.email.trim()
          ) {

            return reply
              .code(400)
              .send({
                success: false,
                error:
                  "email is required"
              });

          }

          if (
            typeof body.source !== "string" ||
            !body.source.trim()
          ) {

            return reply
              .code(400)
              .send({
                success: false,
                error:
                  "source is required"
              });

          }

          if (
            typeof body.outcome !== "string" ||
            !body.outcome.trim()
          ) {

            return reply
              .code(400)
              .send({
                success: false,
                error:
                  "outcome is required"
              });

          }

          const record =
            await appendEvidence(
              body
            );

          return reply
            .code(201)
            .send({
              success: true,
              record
            });

        } catch (error) {

          request.log.error(
            error
          );

          return reply
            .code(500)
            .send({
              success: false,
              error:
                error instanceof Error
                  ? error.message
                  : String(error)
            });

        }

      }
    );


    /*
    ==============================================
    GET /evidence/email/:email
    ==============================================
    */

    app.get<{
      Params: {
        email: string;
      };
    }>(
      "/evidence/email/:email",
      async (
        request,
        reply
      ) => {

        try {

          const records =
            await getEvidenceByEmail(
              request.params.email
            );

          return reply
            .code(200)
            .send({
              success: true,
              count:
                records.length,
              records
            });

        } catch (error) {

          request.log.error(
            error
          );

          return reply
            .code(500)
            .send({
              success: false,
              error:
                error instanceof Error
                  ? error.message
                  : String(error)
            });

        }

      }
    );


    /*
    ==============================================
    GET /evidence/verification/:verificationId
    ==============================================
    */

    app.get<{
      Params: {
        verificationId: string;
      };
    }>(
      "/evidence/verification/:verificationId",
      async (
        request,
        reply
      ) => {

        try {

          const records =
            await getEvidenceByVerificationId(
              request.params.verificationId
            );

          return reply
            .code(200)
            .send({
              success: true,
              count:
                records.length,
              records
            });

        } catch (error) {

          request.log.error(
            error
          );

          return reply
            .code(500)
            .send({
              success: false,
              error:
                error instanceof Error
                  ? error.message
                  : String(error)
            });

        }

      }
    );

  };

export default evidenceLedgerRoutes;
import type { FastifyInstance } from "fastify";

import { verifySMTP } from "../services/smtpChecker.js";

export default async function smtpVerifyRoutes(
  app: FastifyInstance
) {

  app.post(
    "/smtp/verify",
    async (request, reply) => {

      const body =
        request.body as {
          email?: string;
          mxHost?: string;
        };

      const email =
        body.email?.trim().toLowerCase();

      const mxHost =
        body.mxHost?.trim();

      if (!email) {

        return reply.code(400).send({
          success: false,
          error: "email required"
        });

      }

      if (!mxHost) {

        return reply.code(400).send({
          success: false,
          error: "mxHost required"
        });

      }

      try {

        const result =
          await verifySMTP(
            email,
            mxHost
          );

        /*
        IMPORTANT:
        Spread first, then explicitly set success.

        This avoids TS2783:
        "'success' is specified more than once"
        */

        return {
          ...result,
          success: true
        };

      } catch (error) {

        const message =
          error instanceof Error
            ? error.message
            : "SMTP verification failed";

        return reply.code(500).send({

          success: false,

          error: message

        });

      }

    }
  );

}
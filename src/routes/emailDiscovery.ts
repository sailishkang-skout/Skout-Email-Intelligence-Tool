import type {
  FastifyInstance,
  FastifyPluginAsync
} from "fastify";

import {
  discoverEmail
} from "../services/emailDiscoveryEngine.js";

interface EmailDiscoveryBody {
  firstName: string;
  lastName?: string | null;
  domain: string;
  maxVerifications?: number;
  verify?: boolean;
}

const emailDiscoveryRoutes: FastifyPluginAsync =
  async (
    app: FastifyInstance
  ) => {

    app.post<{
      Body: EmailDiscoveryBody;
    }>(
      "/email-discovery",
      async (
        request,
        reply
      ) => {

        try {

          const {
            firstName,
            lastName,
            domain,
            maxVerifications,
            verify
          } = request.body ?? {};

          if (
            typeof firstName !== "string" ||
            !firstName.trim()
          ) {

            return reply
              .code(400)
              .send({
                success: false,
                error:
                  "firstName is required"
              });

          }

          if (
            typeof domain !== "string" ||
            !domain.trim()
          ) {

            return reply
              .code(400)
              .send({
                success: false,
                error:
                  "domain is required"
              });

          }

          const result =
            await discoverEmail({

              firstName,

              lastName:
                lastName ?? null,

              domain,

              ...(maxVerifications !== undefined
                ? {
                    maxVerifications
                  }
                : {}),

              ...(verify !== undefined
                ? {
                    verify
                  }
                : {})

            });

          return reply
            .code(200)
            .send(result);

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

export default emailDiscoveryRoutes;
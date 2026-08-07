import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply
} from "fastify";

import { getMX } from "../services/dnsCache.js";

import {
  checkCatchAll
} from "../services/catchAllChecker.js";

interface CatchAllRequestBody {
  email: string;
}

export default async function smtpCatchAllRoutes(
  app: FastifyInstance
) {

  app.post(
    "/smtp/catch-all",
    async (
      request: FastifyRequest<{
        Body: CatchAllRequestBody;
      }>,
      reply: FastifyReply
    ) => {

      const email =
        request.body?.email
          ?.trim()
          .toLowerCase();

      /*
        Validate email.
      */

      if (
        !email ||
        !email.includes("@")
      ) {

        return reply
          .code(400)
          .send({

            success: false,

            error:
              "Valid email is required"

          });

      }

      const atIndex =
        email.lastIndexOf("@");

      if (
        atIndex <= 0 ||
        atIndex === email.length - 1
      ) {

        return reply
          .code(400)
          .send({

            success: false,

            error:
              "Invalid email address"

          });

      }

      const domain =
        email
          .slice(
            atIndex + 1
          )
          .trim()
          .toLowerCase();

      /*
        Resolve MX.
      */

      const mxRecords =
        await getMX(domain);

      if (
        !mxRecords ||
        mxRecords.length === 0
      ) {

        return reply
          .code(422)
          .send({

            success: false,

            email,

            domain,

            error:
              "No MX records found"

          });

      }

      /*
        Sort MX records by
        priority without mutating
        the DNS cache result.
      */

      const sortedMX =
        [...mxRecords].sort(
          (a, b) =>
            a.priority -
            b.priority
        );

      const primaryMX =
        sortedMX[0]?.exchange;

      if (!primaryMX) {

        return reply
          .code(422)
          .send({

            success: false,

            email,

            domain,

            error:
              "Unable to determine primary MX host"

          });

      }

      /*
        Catch-all verification.
      */

      const result =
        await checkCatchAll(
          email,
          primaryMX
        );

      return reply.send({

        success: true,

        email,

        domain,

        mx: {

          primary:
            primaryMX,

          hosts:
            sortedMX.map(
              record =>
                record.exchange
            )

        },

        catchAll:
          result

      });

    }
  );

}
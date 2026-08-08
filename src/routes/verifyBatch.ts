import type { FastifyInstance } from "fastify";

import { verifyBatch } from "../services/batchVerification.js";


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

const MAX_BATCH_SIZE = 100;

export default async function verifyBatchRoutes(
  app: FastifyInstance
) {

  app.post(
    "/verify/batch",
    async (
      request,
      reply
    ) => {

      const body =
        request.body as BatchRequestBody;


      const emails =
        body.emails;


      if (
        !Array.isArray(emails)
      ) {

        return reply.code(400).send({

          success: false,

          error:
            "emails array required"

        });

      }


      /*
      ----------------------------------------------
      LIMIT

      Prevent a single request from opening an
      unbounded number of SMTP connections.
      ----------------------------------------------
      */

      if (
        emails.length >
        MAX_BATCH_SIZE
      ) {

        return reply.code(400).send({

          success: false,

          error:
            `Maximum batch size is ${MAX_BATCH_SIZE}`

        });

      }


      if (
        emails.length === 0
      ) {

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

}

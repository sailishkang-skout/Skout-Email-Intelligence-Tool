import type { FastifyInstance } from "fastify";

import mailchecker from "mailchecker";

import { verifyEmail } from "../services/emailVerificationOrchestrator.js";


/*
==================================================
MAILCHECKER ADAPTER
==================================================
*/

function isDisposableEmail(
  domain: string
): boolean {

  const checker =
    mailchecker as unknown as {

      isDisposable?: (
        domain: string
      ) => boolean;

      default?: {

        isDisposable?: (
          domain: string
        ) => boolean;

      };

    };


  if (
    typeof checker.isDisposable ===
    "function"
  ) {

    return checker.isDisposable(
      domain
    );

  }


  if (
    typeof checker.default?.isDisposable ===
    "function"
  ) {

    return checker.default.isDisposable(
      domain
    );

  }


  return false;

}


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
*/

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
      ----------------------------------------------

      Prevent accidental huge requests.

      This can later be moved into configuration.
      */

      const MAX_BATCH_SIZE =
        100;


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


      /*
      ----------------------------------------------
      EMPTY BATCH
      ----------------------------------------------
      */

      if (
        emails.length === 0
      ) {

        return {

          success: true,

          count: 0,

          results: []

        };

      }


      /*
      ----------------------------------------------
      PROCESS
      ----------------------------------------------
      */

      const results =
        await Promise.all(

          emails.map(
            async (
              rawEmail
            ) => {

              const email =
                typeof rawEmail ===
                "string"
                  ? rawEmail
                      .trim()
                      .toLowerCase()
                  : "";


              if (!email) {

                return {

                  success: false,

                  email:
                    rawEmail,

                  error:
                    "Invalid email"

                };

              }


              const emailParts =
                email.split("@");


              if (
                emailParts.length !== 2 ||
                !emailParts[1]
              ) {

                return {

                  success: false,

                  email,

                  error:
                    "Invalid email address"

                };

              }


              const domain =
                emailParts[1]
                  .trim()
                  .toLowerCase();


              const disposable =
                isDisposableEmail(
                  domain
                );


              try {

                const result =
                  await verifyEmail(
                    email
                  );


                return {

                  ...result,

                  disposable

                };

              } catch (error) {

                const message =
                  error instanceof Error
                    ? error.message
                    : "Email verification failed";


                return {

                  success: false,

                  email,

                  domain,

                  disposable,

                  error:
                    message

                };

              }

            }
          )

        );


      /*
      ----------------------------------------------
      RESPONSE
      ----------------------------------------------
      */

      return {

        success: true,

        count:
          results.length,

        results

      };

    }
  );

}
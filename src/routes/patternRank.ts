import type { FastifyInstance } from "fastify";

import {
  rankEmailCandidates
} from "../services/patternRanker.js";

import { extractErrorMessage } from "../utils/errorMessage.js";


interface PatternRankRequest {

  domain: string;

  patterns: {

    pattern: string;

    email: string;

    priority?: number;

  }[];

}



export default async function patternRankRoutes(
  app: FastifyInstance
) {


  app.post(
    "/patterns/rank",
    async (
      request,
      reply
    ) => {


      const body =
        request.body as Partial<PatternRankRequest>;



      /*
      --------------------------------------
      VALIDATE BODY
      --------------------------------------
      */


      if (
        !body ||
        typeof body.domain !== "string" ||
        !body.domain.trim()
      ) {

        return reply
          .code(400)
          .send({

            success:false,

            error:
              "domain required"

          });

      }



      if (
        !Array.isArray(
          body.patterns
        )
      ) {

        return reply
          .code(400)
          .send({

            success:false,

            error:
              "patterns array required"

          });

      }



      /*
      --------------------------------------
      NORMALIZE CANDIDATES

      Ranker expects:

      {
        email,
        pattern,
        rank
      }

      --------------------------------------
      */


      const candidates =
        body.patterns
          .filter(
            (
              item
            ) =>
              item &&
              typeof item.email === "string" &&
              typeof item.pattern === "string"
          )
          .map(
            (
              item,
              index
            ) => ({

              email:
                item.email.trim(),

              pattern:
                item.pattern.trim(),

              rank:
                index + 1

            })
          );



      if (
        candidates.length === 0
      ) {

        return reply
          .code(400)
          .send({

            success:false,

            error:
              "no valid candidates supplied"

          });

      }



      /*
      --------------------------------------
      RUN PATTERN RANKER
      --------------------------------------
      */


      let result;

      try {

        result =
          await rankEmailCandidates(
            body.domain,
            candidates
          );

      } catch (
        error: unknown
      ) {

        request.log.error(
          {
            error: extractErrorMessage(error),

            domain: body.domain,
          },
          "[PatternRankRoute] Ranking failed"
        );

        return reply
          .code(500)
          .send({
            success: false,

            error:
              "Pattern ranking failed",
          });
      }



      return {

        success:true,

        domain:
          result.domain,

        ranked_candidates:
          result.candidates,

        recommended:
          result.recommended

      };


    }
  );


}
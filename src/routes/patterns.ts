import type { FastifyInstance } from "fastify";

import {
  PatternHistoryRepository
} from "../repositories/patternHistoryRepository.js";


const repository =
  new PatternHistoryRepository();


export default async function patternRoutes(
  app: FastifyInstance
) {


  /*
  ==================================================
  GENERATE EMAIL PATTERNS
  ==================================================
  */

  app.post(
    "/patterns",
    async (
      request,
      reply
    ) => {


      const {
        first_name,
        last_name,
        domain
      } =
      request.body as {

        first_name: string;

        last_name: string;

        domain: string;

      };



      if (
        !first_name ||
        !last_name ||
        !domain
      ) {

        return reply
          .code(400)
          .send({

            success:false,

            error:
              "first_name, last_name and domain required"

          });

      }



      const first =
        first_name
          .toLowerCase()
          .replace(
            /[^a-z]/g,
            ""
          );


      const last =
        last_name
          .toLowerCase()
          .replace(
            /[^a-z]/g,
            ""
          );



      const cleanDomain =
        domain
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
          ?.trim()
          ?? "";



      const patterns = [

        {
          pattern:
            "first@domain",

          email:
            `${first}@${cleanDomain}`,

          priority:1
        },


        {
          pattern:
            "first.last@domain",

          email:
            `${first}.${last}@${cleanDomain}`,

          priority:2
        },


        {
          pattern:
            "flast@domain",

          email:
            `${first[0]}${last}@${cleanDomain}`,

          priority:3
        },


        {
          pattern:
            "f.last@domain",

          email:
            `${first[0]}.${last}@${cleanDomain}`,

          priority:4
        },


        {
          pattern:
            "last@domain",

          email:
            `${last}@${cleanDomain}`,

          priority:5
        },


        {
          pattern:
            "firstl@domain",

          email:
            `${first}${last[0]}@${cleanDomain}`,

          priority:6
        }


      ];



      return {

        success:true,


        person:{

          first_name,

          last_name

        },


        domain:
          cleanDomain,


        patterns

      };


    }
  );





  /*
  ==================================================
  GET LEARNED PATTERN HISTORY BY DOMAIN
  ==================================================

  Example:

  GET /patterns/stripe.com

  Returns:

  {
    domain:"stripe.com",
    patterns:[
       {
          pattern:"first@domain",
          attempts:11,
          successes:11,
          confidence:93
       }
    ]
  }

  ==================================================
  */


  app.get(
    "/patterns/:domain",
    async (
      request,
      reply
    ) => {


      const {
        domain
      } =
      request.params as {

        domain:string;

      };



      if (
        !domain
      ) {

        return reply
          .code(400)
          .send({

            success:false,

            error:
              "domain required"

          });

      }



      const cleanDomain =
        domain
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
          ?.trim()
          ?? "";



      const patterns =
        repository.findByDomain(
          cleanDomain
        );



      return {

        success:true,

        domain:
          cleanDomain,

        patterns

      };


    }
  );


}
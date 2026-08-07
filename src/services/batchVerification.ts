import {
  ConcurrencyLimiter
} from "./concurrencyLimiter.js";


import {
  withRetry
} from "./retryScheduler.js";


import {
  verifyEmail
} from "./emailVerificationOrchestrator.js";



export interface BatchVerificationInput {

  emails:string[];

}



export async function verifyBatch(
 input:BatchVerificationInput
){


 const limiter =
   new ConcurrencyLimiter(10);



 const results =
   await Promise.all(

    input.emails.map(

      email =>

      limiter.run(

        () =>

        withRetry(

          () =>
            verifyEmail(email),

          {
            attempts:3,
            delayMs:1000
          }

        )

      )

    )

   );


 return {

   total:
     results.length,


   results

 };

}
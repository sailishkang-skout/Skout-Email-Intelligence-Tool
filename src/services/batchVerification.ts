import mailchecker from "mailchecker";

import {
  ConcurrencyLimiter
} from "./concurrencyLimiter.js";


import {
  withRetry
} from "./retryScheduler.js";


import {
  verifyEmail
} from "./emailVerificationOrchestrator.js";


/*
==================================================
BATCH VERIFICATION
==================================================

Canonical batch verification path. Runs each email
through the same orchestrator used by single-email
verification, but bounds concurrency (so a large
batch cannot open unlimited simultaneous SMTP
connections) and retries transient failures.

One bad/unverifiable email must never fail the
whole batch, so each item is isolated.
==================================================
*/

const MAX_CONCURRENT_VERIFICATIONS = 10;

export interface BatchVerificationInput {

  emails:string[];

}


export interface BatchVerificationItemResult {

  success:boolean;

  email:string;

  domain?:string;

  disposable:boolean;

  error?:string|null;

  [key:string]:unknown;

}


function isDisposableEmail(
  email:string
):boolean {

  try {

    return !mailchecker.isValid(
      email
    );

  } catch {

    return false;

  }

}


async function verifyOne(
  rawEmail:string,
  limiter:ConcurrencyLimiter
):Promise<BatchVerificationItemResult> {

  const email =
    typeof rawEmail === "string"
      ? rawEmail.trim().toLowerCase()
      : "";

  if (!email) {

    return {
      success:false,
      email:rawEmail,
      disposable:false,
      error:"Invalid email"
    };

  }

  const domain =
    email.split("@")[1];

  if (!domain) {

    return {
      success:false,
      email,
      disposable:false,
      error:"Invalid email address"
    };

  }

  const disposable =
    isDisposableEmail(email);

  try {

    const result =
      await limiter.run(
        () =>
          withRetry(
            () => verifyEmail(email),
            {
              attempts:3,
              delayMs:1000
            }
          )
      );

    return {

      ...result,

      domain,

      disposable

    };

  } catch (error) {

    return {

      success:false,

      email,

      domain,

      disposable,

      error:
        error instanceof Error
          ? error.message
          : "Email verification failed"

    };

  }

}


export async function verifyBatch(
 input:BatchVerificationInput
){


 const limiter =
   new ConcurrencyLimiter(
     MAX_CONCURRENT_VERIFICATIONS
   );


 const results =
   await Promise.all(
    input.emails.map(
      email =>
        verifyOne(email, limiter)
    )
   );


 return {

   total:
     results.length,


   results

 };

}

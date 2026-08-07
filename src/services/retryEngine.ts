export interface RetryDecision {

  shouldRetry:boolean;

  retryAfterSeconds:number;

  maxAttempts:number;

  reason:string;

}



export function checkRetry(
  responseCode:number | null
):RetryDecision {


  /*
    Temporary SMTP failures
    4xx codes
  */

  if(
    responseCode &&
    responseCode >= 400 &&
    responseCode < 500
  ){

    return {

      shouldRetry:true,

      retryAfterSeconds:60,

      maxAttempts:3,

      reason:
        "Temporary SMTP failure"

    };

  }



  /*
    Permanent failures
    5xx codes
  */

  if(
    responseCode &&
    responseCode >= 500
  ){

    return {

      shouldRetry:false,

      retryAfterSeconds:0,

      maxAttempts:0,

      reason:
        "Permanent SMTP failure"

    };

  }



  /*
    No retry required
  */

  return {

    shouldRetry:false,

    retryAfterSeconds:0,

    maxAttempts:3,

    reason:
      "No retry required"

  };


}
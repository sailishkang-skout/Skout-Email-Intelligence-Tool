export interface ReasonInput {

  smtpValid?: boolean;

  mailboxExists?: boolean | null;

  provider?: string;

  patternScore?: number;

  catchAll?: boolean;

  retryRequired?: boolean;

}



export function generateReasonCodes(
  input:ReasonInput
):string[] {


  const reasons:string[] = [];



  if(input.smtpValid === true){

    reasons.push(
      "SMTP_MAILBOX_ACCEPTED"
    );

  }



  if(input.mailboxExists === true){

    reasons.push(
      "MAILBOX_CONFIRMED"
    );

  }



  if(
    typeof input.patternScore === "number" &&
    input.patternScore >= 90
  ){

    reasons.push(
      "HIGH_PATTERN_MATCH"
    );

  }



  if(
    input.provider &&
    input.provider !== "OTHER"
  ){

    reasons.push(
      `${input.provider}_PROVIDER_DETECTED`
    );

  }



  if(input.catchAll === false){

    reasons.push(
      "NO_CATCH_ALL_DETECTED"
    );

  }



  if(input.catchAll === true){

    reasons.push(
      "CATCH_ALL_DOMAIN"
    );

  }



  if(input.retryRequired === true){

    reasons.push(
      "SMTP_RETRY_REQUIRED"
    );

  }



  return reasons;


}
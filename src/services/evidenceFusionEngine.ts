export interface EvidenceFusionInput {

  confidenceScore: number;

  domainReputationScore?: number;

  organizationTrustScore?: number;

  emailHistoryScore?: number;

  providerScore?: number;

  patternScore?: number;

  smtpValid: boolean;

  mailboxExists: boolean;

  catchAll: boolean;

}


export interface EvidenceFusionResult {

  score: number;

  confidence:
    | "VERY_HIGH"
    | "HIGH"
    | "MEDIUM"
    | "LOW"
    | "VERY_LOW";

  signals: string[];

}



export function fuseEvidence(
  input: EvidenceFusionInput
): EvidenceFusionResult {


  let score = 0;

  const signals:string[] = [];


  /*
  Core verification
  */

  score += input.confidenceScore * 0.45;


  if(input.smtpValid){

    score += 15;

    signals.push(
      "SMTP validation passed"
    );

  }


  if(input.mailboxExists){

    score += 15;

    signals.push(
      "Mailbox exists"
    );

  }



  /*
  Intelligence layers
  */

  if(input.domainReputationScore){

    score +=
      input.domainReputationScore * 0.1;

    signals.push(
      "Domain reputation applied"
    );

  }


  if(input.organizationTrustScore){

    score +=
      input.organizationTrustScore * 0.1;

    signals.push(
      "Organization trust applied"
    );

  }


  if(input.emailHistoryScore){

    score +=
      input.emailHistoryScore * 0.05;

    signals.push(
      "Email history applied"
    );

  }


  if(input.providerScore){

    score +=
      input.providerScore * 0.05;

    signals.push(
      "Provider intelligence applied"
    );

  }


  if(input.patternScore){

    score +=
      input.patternScore * 0.1;

    signals.push(
      "Pattern intelligence applied"
    );

  }



  /*
  Risk penalties
  */

  if(input.catchAll){

    score -= 25;

    signals.push(
      "Catch-all penalty applied"
    );

  }



  score = Math.max(
    0,
    Math.min(
      100,
      Math.round(score)
    )
  );



  let confidence:
    | "VERY_HIGH"
    | "HIGH"
    | "MEDIUM"
    | "LOW"
    | "VERY_LOW";


  if(score >= 90){

    confidence = "VERY_HIGH";

  } else if(score >= 75){

    confidence = "HIGH";

  } else if(score >= 55){

    confidence = "MEDIUM";

  } else if(score >= 30){

    confidence = "LOW";

  } else {

    confidence = "VERY_LOW";

  }



  return {

    score,

    confidence,

    signals

  };

}
/*
==================================================
VERIFICATION DECISION ENGINE
==================================================

Purpose:

Convert verification evidence into a final
business decision.

This is the final intelligence layer.

It does NOT:
- perform DNS
- perform SMTP
- modify evidence
- modify history

It ONLY decides:

SAFE_TO_SEND
DO_NOT_SEND
RETRY
MANUAL_REVIEW

==================================================
*/


export type VerificationDecision =
  | "SAFE_TO_SEND"
  | "DO_NOT_SEND"
  | "RETRY"
  | "MANUAL_REVIEW";


export interface VerificationDecisionInput {

  /*
  Core SMTP evidence
  */

  smtpValid:boolean;

  mailboxExists:boolean;

  responseCode:number | null;


  /*
  DNS evidence
  */

  mxAvailable:boolean;


  /*
  Catch-all intelligence
  */

  catchAll:boolean;


  /*
  Retry state
  */

  retryRequired:boolean;


  /*
  Confidence engine output
  */

  confidenceScore:number;


  /*
  Pattern intelligence
  */

  patternConfidence?:number | null;

  patternSuccessRate?:number | null;


  /*
  Provider intelligence
  */

  providerDetected?:boolean;

  patternReliabilityScore?: number | null;

patternRiskLevel?:
  | "CRITICAL"
  | "HIGH"
  | "MEDIUM"
  | "LOW"
  | "VERY_LOW"
  | undefined;


patternCompetitiveAdvantage?: number | null;

patternTrend?:
  | "IMPROVING"
  | "STABLE"
  | "DECLINING"
  | "UNKNOWN"
  | null;

}



export interface VerificationDecisionResult {

  decision:
    VerificationDecision;


  confidence:
    number;


  reasons:
    string[];


  blockers:
    string[];


  explainability:{
    positiveSignals:string[];

    negativeSignals:string[];
  };

}



/*
==================================================
HELPERS
==================================================
*/


function clamp(
  value:number,
  min:number,
  max:number
){

  return Math.max(
    min,
    Math.min(
      max,
      value
    )
  );

}



/*
==================================================
MAIN ENGINE
==================================================
*/


export function buildVerificationDecision(
  input:VerificationDecisionInput
):VerificationDecisionResult {


  const reasons:string[] = [];

  const blockers:string[] = [];


  const positiveSignals:string[] = [];

  const negativeSignals:string[] = [];



  /*
  ==================================================
  TEMPORARY CONDITIONS
  ==================================================
  */


  if(
    input.retryRequired
  ){

    blockers.push(
      "Temporary verification failure"
    );


    negativeSignals.push(
      "Retry required"
    );


    return {

      decision:
        "RETRY",

      confidence:
        clamp(
          input.confidenceScore,
          0,
          100
        ),


      reasons:[
        "Verification should be retried before making a sending decision."
      ],


      blockers,


      explainability:{

        positiveSignals,

        negativeSignals

      }

    };

  }

/*
==================================================
PATTERN INTELLIGENCE RISK GUARD
==================================================
*/

if (
  input.patternRiskLevel === "CRITICAL"
) {

  return {

    decision:
      "MANUAL_REVIEW",

    confidence:
      clamp(
        input.confidenceScore,
        0,
        100
      ),

    reasons:[
      "Pattern intelligence indicates insufficient trust."
    ],

    blockers,

    explainability:{
      positiveSignals,
      negativeSignals
    }

  };

}


if (
  input.patternRiskLevel === "HIGH" &&
  (
    input.patternReliabilityScore ?? 0
  ) < 50
) {

  return {

    decision:
      "MANUAL_REVIEW",

    confidence:
      clamp(
        input.confidenceScore,
        0,
        100
      ),

    reasons:[
      "Pattern reliability is too weak."
    ],

    blockers,

    explainability:{
      positiveSignals,
      negativeSignals
    }

  };

}

  /*
  ==================================================
  DOMAIN FAILURE
  ==================================================
  */


  if(
    !input.mxAvailable
  ){

    blockers.push(
      "No MX record found"
    );


    negativeSignals.push(
      "Domain cannot receive email"
    );


   return {

  decision:
    "DO_NOT_SEND",

  confidence:
    clamp(
      input.confidenceScore,
      0,
      100
    ),

  reasons:[
    "Domain has no valid mail routing."
  ],

  blockers,

  explainability:{
    positiveSignals,
    negativeSignals
   }

};

}

  /*
  ==================================================
  CATCH ALL
  ==================================================
  */

if(
  input.catchAll
){

  blockers.push(
    "Catch-all domain detected"
  );


  negativeSignals.push(
    "Mailbox existence cannot be reliably confirmed"
  );


  return {

    decision:
      "MANUAL_REVIEW",

    confidence:
      Math.min(
        input.confidenceScore,
        69
      ),

    reasons:[
      "Domain accepts unknown recipients."
    ],

    blockers,

    explainability:{
      positiveSignals,
      negativeSignals
    }

  };

}

  /*
  ==================================================
  HARD INVALID SMTP
  ==================================================
  */


  if(

    input.responseCode !== null &&

    input.responseCode >= 500 &&

    !input.mailboxExists

  ){

    blockers.push(
      "Permanent SMTP rejection"
    );


    negativeSignals.push(
      `SMTP ${input.responseCode}`
    );


    return {

      decision:
        "DO_NOT_SEND",


      confidence:
        clamp(
          input.confidenceScore,
          0,
          100
        ),


      reasons:[
        "SMTP server rejected the mailbox."
      ],


      blockers,


      explainability:{
        positiveSignals,
        negativeSignals
      }

    };

  }



  /*
  ==================================================
  VERIFIED EMAIL
  ==================================================
  */

 if (
  input.smtpValid &&
  input.mailboxExists &&
  input.confidenceScore >= 80
) {

    reasons.push(
      "SMTP validation succeeded"
    );


    reasons.push(
      "Mailbox existence confirmed"
    );


    reasons.push(
      "High confidence score"
    );


    positiveSignals.push(
      "SMTP accepted recipient"
    );


    positiveSignals.push(
      "Mailbox exists"
    );


    return {

      decision:
        "SAFE_TO_SEND",


      confidence:
        clamp(
          input.confidenceScore,
          0,
          100
        ),


      reasons,


      blockers,


      explainability:{
        positiveSignals,
        negativeSignals
       }
};

}

  /*
  ==================================================
  PATTERN SUPPORTED
  ==================================================
  */


  if(

  input.patternSuccessRate !== null &&

  input.patternSuccessRate !== undefined &&

  input.patternSuccessRate >= 0.9 &&

  input.confidenceScore >= 60

){

    reasons.push(
      "Strong historical email pattern"
    );


    positiveSignals.push(
      "Pattern intelligence confidence high"
    );


     return {

      decision:
        "MANUAL_REVIEW",

      confidence:
        clamp(
          input.confidenceScore,
          0,
          100
        ),

      reasons:[
        "Strong historical email pattern detected."
      ],

      blockers,

      explainability:{
        positiveSignals,
        negativeSignals
       }

};

} 
  /*
  ==================================================
  LOW CONFIDENCE
  ==================================================
  */


  if(
    input.confidenceScore < 30
  ){

    blockers.push(
      "Insufficient verification confidence"
    );


    negativeSignals.push(
      "Low evidence score"
    );


    return {

      decision:
        "DO_NOT_SEND",


      confidence:
        input.confidenceScore,


      reasons:[
        "Evidence does not support sending."
      ],


      blockers,


      explainability:{
        positiveSignals,
        negativeSignals
      }

    };

  }



  /*
  ==================================================
  DEFAULT
  ==================================================
  */


  return {

    decision:
      "MANUAL_REVIEW",


    confidence:
      clamp(
        input.confidenceScore,
        0,
        100
      ),


    reasons:[

      "Evidence is inconclusive."

    ],


    blockers:[

      "Manual review required"

    ],


    explainability:{

      positiveSignals,

      negativeSignals

    }

  };

}



export default buildVerificationDecision;
/*
==================================================
EVIDENCE WEIGHTING ENGINE
==================================================

Purpose

Transforms raw verification evidence into a
normalized weighted evidence model.

This engine DOES NOT:

- calculate confidence
- decide send eligibility
- build recommendations

It only answers:

"What evidence contributed to the decision?"

Architecture

SMTP
DNS
Catch-All
Pattern Intelligence
Provider Detection
↓

Weighted Evidence

↓

Confidence Engine
Decision Engine
Recommendation Engine

==================================================
*/

export type EvidenceType =
  | "SMTP_SUCCESS"
  | "SMTP_FAILURE"
  | "SMTP_TEMPORARY"
  | "MAILBOX_EXISTS"
  | "MAILBOX_MISSING"
  | "MX_PRESENT"
  | "MX_MISSING"
  | "CATCH_ALL"
  | "PATTERN"
  | "PROVIDER";

export interface EvidenceWeightInput {

  mxAvailable:boolean;

  smtpValid:boolean;

  mailboxExists:boolean|null;

  catchAll:boolean;

  retryRequired:boolean;

  providerDetected:boolean;

  responseCode:number|null;

  patternScore?:number|null;

}

export interface WeightedEvidenceInput{

  type:EvidenceType;

  description:string;

  weight:number;

  positive:boolean;

}

export interface WeightedEvidence{

  type:EvidenceType;

  description:string;

  weight:number;

  positive:boolean;

}

export interface EvidenceWeightResult{

  totalPositive:number;

  totalNegative:number;

  netWeight:number;

  strongestPositive:WeightedEvidence|null;

  strongestNegative:WeightedEvidence|null;

  evidence:WeightedEvidence[];

}

/*
==================================================
HELPERS
==================================================
*/

function addEvidence(

  list:WeightedEvidence[],

  type:EvidenceType,

  description:string,

  weight:number

){

  list.push({

    type,

    description,

    weight,

    positive:weight>0

  });

}

function strongestPositive(

  evidence:WeightedEvidence[]

):WeightedEvidence|null{

  const positives=

    evidence.filter(

      e=>e.weight>0

    );

  if(!positives.length){

    return null;

  }

  positives.sort(

    (a,b)=>

      b.weight-a.weight

  );

  return positives[0];

}

function strongestNegative(

  evidence:WeightedEvidence[]

):WeightedEvidence|null{

  const negatives=

    evidence.filter(

      e=>e.weight<0

    );

  if(!negatives.length){

    return null;

  }

  negatives.sort(

    (a,b)=>

      a.weight-b.weight

  );

  return negatives[0];

}

function calculateTotals(

  evidence:WeightedEvidence[]

){

  let totalPositive=0;

  let totalNegative=0;

  for(const item of evidence){

    if(item.weight>0){

      totalPositive+=item.weight;

    }else{

      totalNegative+=Math.abs(item.weight);

    }

  }

  return{

    totalPositive,

    totalNegative,

    netWeight:

      totalPositive-totalNegative

  };

}

/*
==================================================
MAIN ENGINE
==================================================
*/

export function calculateEvidenceWeights(

  input:EvidenceWeightInput

):EvidenceWeightResult{

  const evidence:WeightedEvidence[]=[];

  /*
  ==========================================
  MX
  ==========================================
  */

  if(input.mxAvailable){

    addEvidence(

      evidence,

      "MX_PRESENT",

      "Valid MX records were found.",

      15

    );

  }else{

    addEvidence(

      evidence,

      "MX_MISSING",

      "No valid MX records were found.",

      -20

    );

  }

  /*
  ==========================================
  SMTP
  ==========================================
  */

  if(

    input.responseCode!==null &&

    input.responseCode>=200 &&

    input.responseCode<300 &&

    input.smtpValid

  ){

    addEvidence(

      evidence,

      "SMTP_SUCCESS",

      "SMTP server accepted recipient.",

      40

    );

  }

  if(

    input.responseCode!==null &&

    input.responseCode>=500 &&

    input.responseCode<600

  ){

    addEvidence(

      evidence,

      "SMTP_FAILURE",

      "SMTP server rejected recipient.",

      -45

    );

  }

  if(

    input.retryRequired ||

    (

      input.responseCode!==null &&

      input.responseCode>=400 &&

      input.responseCode<500

    )

  ){

    addEvidence(

      evidence,

      "SMTP_TEMPORARY",

      "Temporary SMTP failure occurred.",

      -15

    );

  }
    /*
  ==========================================
  MAILBOX
  ==========================================
  */

  if(input.mailboxExists === true){

    addEvidence(

      evidence,

      "MAILBOX_EXISTS",

      "Mailbox existence was confirmed.",

      35

    );

  }else if(
    input.responseCode!==null &&
    input.responseCode>=500 &&
    input.responseCode<600
  ){

    addEvidence(

      evidence,

      "MAILBOX_MISSING",

      "SMTP server definitively rejected the mailbox.",

      -35

    );

  }

  /*
  ==========================================
  CATCH-ALL
  ==========================================
  */

  if(input.catchAll){

    addEvidence(

      evidence,

      "CATCH_ALL",

      "Domain accepts arbitrary recipients (catch-all).",

      -40

    );

  }

  /*
  ==========================================
  PROVIDER
  ==========================================
  */

  if(input.providerDetected){

    addEvidence(

      evidence,

      "PROVIDER",

      "Email provider successfully identified.",

      5

    );

  }

  /*
  ==========================================
  PATTERN INTELLIGENCE
  ==========================================
  */

  if(

    input.patternScore !== undefined &&

    input.patternScore !== null &&

    Number.isFinite(input.patternScore)

  ){

    const normalizedPattern =

      Math.max(

        0,

        Math.min(

          20,

          input.patternScore / 5

        )

      );

    if(normalizedPattern > 0){

      addEvidence(

        evidence,

        "PATTERN",

        "Historical email pattern intelligence contributed to the verification.",

        normalizedPattern

      );

    }

  }

  /*
  ==========================================
  SORT EVIDENCE

  Highest absolute impact first.

  This makes explanation, auditing and AI
  reasoning much easier.
  ==========================================
  */

  evidence.sort(

    (a,b)=>

      Math.abs(b.weight)

      -

      Math.abs(a.weight)

  );

  /*
  ==========================================
  TOTALS
  ==========================================
  */

  const totals =

    calculateTotals(

      evidence

    );

  /*
  ==========================================
  RESULT
  ==========================================
  */

  return{

    totalPositive:

      totals.totalPositive,

    totalNegative:

      totals.totalNegative,

    netWeight:

      totals.netWeight,

    strongestPositive:

      strongestPositive(

        evidence

      ),

    strongestNegative:

      strongestNegative(

        evidence

      ),

    evidence

  };

}

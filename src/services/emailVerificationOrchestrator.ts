import { randomUUID } from "node:crypto";

import { getMX } from "./dnsCache.js";
import { verifySMTP } from "./smtpChecker.js";
import { checkCatchAll } from "./catchAllChecker.js";

import {
  calculateEvidenceConfidence
} from "./confidenceEngine.js";

import {
  buildVerificationDecision
} from "./verificationDecisionEngine.js";

import {
  recordEvidence
} from "./evidenceLedger.js";

import {
  recordVerificationAttempt
} from "./verificationAttemptHistory.js";

import {
  evaluatePatternEvidence
} from "./patternEvidence.js";

import {
  getPatternIntelligence
} from "./patternIntelligence.js";

import {
  buildVerificationStatus
} from "../types/verificationStatus.js";

import {
  analyzeVerificationEvidence
} from "./evidenceAnalyzer.js";

import {
  calculateEvidenceWeights
} from "./evidenceWeighting.js";

import {
  collectVerificationEvidence
} from "./evidenceCollector.js";

import {
  EvidenceRepository
} from "../repositories/evidenceRepository.js";


import {
  VerificationRepository
} from "../repositories/verificationRepository.js";

import {
  VerificationEventRepository
} from "../repositories/verificationEventRepository.js";

import type {
  VerifyEmailResult
} from "../types/verificationResult.js";

import type {
  NormalizedSMTPResult
} from "../types/smtp.js";

const verificationRepository =
  new VerificationRepository();

const verificationEventRepository =
  new VerificationEventRepository();

const evidenceRepository =
  new EvidenceRepository();

import {
 createVerificationDecision
} from "../repositories/verificationDecisionRepository.js";



/*
==================================================
NORMALIZED TYPES
==================================================
*/



/*
==================================================
EMAIL NORMALIZATION
==================================================
*/


function normalizeEmail(
  email:string
):string {

  return email
    .trim()
    .toLowerCase();

}



/*
==================================================
DOMAIN EXTRACTION
==================================================
*/


function extractDomain(
  email:string
):string {

  const index =
    email.lastIndexOf("@");


  if(
    index <= 0 ||
    index >= email.length - 1
  ){

    throw new Error(
      "Invalid email address"
    );

  }


  const local =
    email
      .slice(0,index)
      .trim();


  const domain =
    email
      .slice(index + 1)
      .trim()
      .toLowerCase();



  if(
    !local ||
    !domain
  ){

    throw new Error(
      "Invalid email address"
    );

  }


  return domain;

}



/*
==================================================
DOMAIN NORMALIZATION
==================================================
*/


function normalizeDomain(
  domain:string
):string {

  return domain
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
    ?.trim() ?? "";

}



/*
==================================================
SMTP NORMALIZER
==================================================
*/


function normalizeSMTPResult(
  raw:unknown
):NormalizedSMTPResult {


  const value =
    raw &&
    typeof raw === "object"
      ? raw as Record<string,unknown>
      : {};



  return {


    responseCode:
      typeof value.responseCode === "number"
        ? value.responseCode
        : null,


    responseMessage:
      typeof value.responseMessage === "string"
        ? value.responseMessage
        : null,


    mailboxExists:
      typeof value.mailboxExists === "boolean"
        ? value.mailboxExists
        : false,


    smtpValid:
      typeof value.smtpValid === "boolean"
        ? value.smtpValid
        : false,


    mxAvailable:
      typeof value.mxAvailable === "boolean"
        ? value.mxAvailable
        : false,


    mxHosts:
      Array.isArray(value.mxHosts)
        ? value.mxHosts.filter(
            (
              item
            ):item is string =>
              typeof item === "string"
          )
        : [],


    primaryMX:
      typeof value.primaryMX === "string"
        ? value.primaryMX
        : null,


    provider:
      typeof value.provider === "string"
        ? value.provider
        : null,


    retryRequired:
      typeof value.retryRequired === "boolean"
        ? value.retryRequired
        : false,


    retryReason:
      typeof value.retryReason === "string"
        ? value.retryReason
        : null,


    error:
      typeof value.error === "string"
        ? value.error
        : null

  };

}
/*
==================================================
CATCH ALL NORMALIZER
==================================================
*/

function normalizeCatchAll(
  raw:unknown
):boolean {


  if(
    typeof raw === "boolean"
  ){

    return raw;

  }


  if(
    raw &&
    typeof raw === "object"
  ){

    const value =
      raw as Record<string,unknown>;



    if(
      typeof value.isCatchAll === "boolean"
    ){

      return value.isCatchAll;

    }



    if(
      typeof value.catchAll === "boolean"
    ){

      return value.catchAll;

    }



    if(
      typeof value.detected === "boolean"
    ){

      return value.detected;

    }

  }


  return false;

}

/*
==================================================
BUILD RECOMMENDATION
==================================================
*/


function buildRecommendation(
  input:{
    score:number;

    mailboxExists:boolean;

    smtpValid:boolean;

    catchAll:boolean;

    retryRequired:boolean;

  }

):VerifyEmailResult["intelligence"]["recommendation"] {

  /*
  ============================================
  TEMPORARY FAILURE
  ============================================
  */

  if(
    input.retryRequired
  ){

    return {

      recommendation:
        "RETRY",

      action:
        "RETRY_VERIFICATION",

      reason:
        "Verification requires retry because the result was temporary."

    };

  }



  /*
  ============================================
  CATCH ALL DOMAIN
  ============================================
  */

  if(
    input.catchAll
  ){

    return {

      recommendation:
        "REVIEW",

      action:
        "MANUAL_REVIEW",

      reason:
        "Domain is catch-all and mailbox existence cannot be guaranteed."

    };

  }



  /*
  ============================================
  HARD INVALID MAILBOX
  SMTP FAILURE / MAILBOX DOES NOT EXIST
  ============================================
  */

  if(
    !input.mailboxExists &&
    !input.smtpValid
  ){

    return {

      recommendation:
        "DO_NOT_SEND",

      action:
        "DO_NOT_USE",

      reason:
        "SMTP verification failed and mailbox does not exist."

    };

  }



  /*
  ============================================
  VERIFIED MAILBOX
  ============================================
  */

 if (
  input.smtpValid &&
  input.mailboxExists &&
  input.score >= 80
) {


    return {

      recommendation:
        "SAFE_TO_SEND",

      action:
        "USE_EMAIL",

      reason:
        "Mailbox validation signals are strong."

    };

  }



  /*
  ============================================
  POSSIBLE VALID BUT NEED REVIEW
  ============================================
  */

  if (
  input.smtpValid &&
  input.mailboxExists &&
  input.score >= 60
) {

    return {

      recommendation:
        "REVIEW",

      action:
        "MANUAL_REVIEW",

      reason:
        "Mailbox appears valid but confidence requires review."

    };

  }



  /*
  ============================================
  LOW CONFIDENCE
  ============================================
  */

  if(
    input.score < 30
  ){

    return {

      recommendation:
        "DO_NOT_SEND",

      action:
        "DO_NOT_USE",

      reason:
        "Verification confidence is too low."

    };

  }



  /*
  ============================================
  DEFAULT SAFE FALLBACK
  ============================================
  */

  return {

    recommendation:
      "REVIEW",

    action:
      "MANUAL_REVIEW",

    reason:
      "Evidence is inconclusive."

  };

}
/*
==================================================
MAIN VERIFICATION FUNCTION
==================================================
*/

export async function verifyEmail(
  emailInput:string,
  options?:{

    requestId?:string|null;

    pattern?:string|null;

  }

):Promise<VerifyEmailResult> {

  if(
  !emailInput ||
  typeof emailInput !== "string"
){

  throw new Error(
    "email is required"
  );

}



  const email =
    normalizeEmail(
      emailInput
    );



  const domain =
    normalizeDomain(
      extractDomain(
        email
      )
    );



const requestId =
  options?.requestId ?? null;

const verificationId =
  randomUUID();

await verificationEventRepository.createEvent({

  verificationId,

  stage: "VERIFICATION",

  status: "STARTED",

  metadata: {

    email,

    domain,

    requestId

  }

});



  const pattern =
    options?.pattern?.trim() || null;



  let smtp: NormalizedSMTPResult = {

  responseCode: null,

  responseMessage: null,

  mailboxExists: false,

  smtpValid: false,

  mxAvailable: false,

  mxHosts: [],

  primaryMX: null,

  provider: null,

  retryRequired: false,

  retryReason: null,

  error: null

};



  let smtpError:string|null;



  /*
  ==================================================
  MX + SMTP VERIFICATION
  ==================================================
  */
await verificationEventRepository.createEvent({

  verificationId,

  stage: "MX",

  status: "STARTED"

});

  try {


    const mxRecords =
      await getMX(
        domain
      );



    const mxHosts =
      mxRecords
        .map(
          item =>
            item.exchange
        )
        .filter(
          Boolean
        );



    smtp.mxHosts =
      mxHosts;



    smtp.primaryMX =
      mxHosts[0] ?? null;



    smtp.mxAvailable =
      mxHosts.length > 0;


await verificationEventRepository.createEvent({

  verificationId,

  stage: "MX",

  status: "COMPLETED",

  metadata: {

    mxAvailable: smtp.mxAvailable,

    hosts: smtp.mxHosts

  }

});

await verificationEventRepository.createEvent({

  verificationId,

  stage: "SMTP",

  status: "STARTED"

});

    if(
      smtp.primaryMX
    ){

      const result =
  await verifySMTP(
    email,
    smtp.primaryMX
  );

      const normalized =
        normalizeSMTPResult(
          result
        );



      smtp =
      {

        ...smtp,

        ...normalized,

        mxHosts,

        primaryMX:
          smtp.primaryMX,

        mxAvailable:true

      };



        }

await verificationEventRepository.createEvent({

  verificationId,

  stage: "SMTP",

  status: "COMPLETED",

  metadata: {

    mailboxExists: smtp.mailboxExists,

    smtpValid: smtp.smtpValid,

    responseCode: smtp.responseCode

  }

});

  }
  catch(error){

  smtpError =
    error instanceof Error
      ? error.message
      : "SMTP verification failed";

  smtp.retryRequired =
    true;

  smtp.retryReason =
    smtpError;

  smtp.error =
    smtpError;

    await verificationEventRepository.createEvent({

  verificationId,

  stage: "SMTP",

  status: "FAILED",

  metadata: {

    error: smtpError,

     retryRequired:
        true

  }

});

}

/*
==================================================
CATCH ALL VERIFICATION
==================================================
*/

await verificationEventRepository.createEvent({

  verificationId,

  stage: "CATCH_ALL",

  status: "STARTED"

});

let catchAll = false;


try {

  if(
    smtp.primaryMX
  ){

    catchAll =
      normalizeCatchAll(
        await checkCatchAll(
          email,
          smtp.primaryMX
        )
      );

  }

}
catch{

  catchAll = false;

}

await verificationEventRepository.createEvent({

  verificationId,

  stage: "CATCH_ALL",

  status: "COMPLETED",

  metadata: {

    catchAll

  }

});
  /*
  ==================================================
  CONFIDENCE ENGINE
  ==================================================
  */
await verificationEventRepository.createEvent({

  verificationId,

  stage: "EVIDENCE",

  status: "STARTED"

});

const collectedEvidence =
  collectVerificationEvidence({

    email,

    domain,

   smtp:{

  responseCode:
    smtp.responseCode,

  responseMessage:
    smtp.responseMessage,

  mailboxExists:
    smtp.mailboxExists,

  smtpValid:
    smtp.smtpValid,

  mxAvailable:
    smtp.mxAvailable,

  mxHosts:
    smtp.mxHosts,

  primaryMX:
    smtp.primaryMX,

  provider:
    smtp.provider,

  retryRequired:
    smtp.retryRequired

},

    catchAll,

    retryReason:
    smtp.retryReason,

    pattern

});

// Evidence collection completed
await verificationEventRepository.createEvent({

  verificationId,

  stage: "EVIDENCE",

  status: "COMPLETED",

  metadata: {

    collected: true,

    signals:
      collectedEvidence.signals?.length ?? 0

  }

});

/*
==================================================
ADVANCED PATTERN INTELLIGENCE SIGNALS
==================================================
*/
const patternIntelligence =
  await getPatternIntelligence(
    domain
  );


const confidence =
  calculateEvidenceConfidence({

    mxAvailable:
      smtp.mxAvailable,

    smtpValid:
      smtp.smtpValid,

    mailboxExists:
      smtp.mailboxExists,

    responseCode:
      smtp.responseCode,

    catchAll,

    retryRequired:
      smtp.retryRequired,

    providerDetected:
      Boolean(
        smtp.provider
      ),


    patternConfidence:
      patternIntelligence.bestPattern
        ?.reliabilityScore ?? null,


    patternSuccessRate:
      patternIntelligence.bestPattern
        ?.successRate ?? null,


    patternAttempts:
      patternIntelligence.bestPattern
        ?.attempts ?? 0,


    patternReliabilityScore:
      patternIntelligence.bestPattern
        ?.reliabilityScore ?? null,


    patternRiskLevel:
      patternIntelligence.bestPattern
        ?.riskLevel ?? undefined,


    patternBayesianConfidence:
      patternIntelligence.bestPattern
        ?.bayesianConfidence ?? null,


    patternWilsonScore:
      patternIntelligence.bestPattern
        ?.wilsonScore ?? null,


    patternStabilityScore:
      patternIntelligence.bestPattern
        ?.stabilityScore ?? null,


    patternTrend:
      patternIntelligence.bestPattern
        ?.trend ?? null,


    patternCompetitiveAdvantage:
      patternIntelligence.bestPattern
        ?.competitiveAdvantage ?? null

});


  /*
==================================================
EVIDENCE WEIGHTING ENGINE
==================================================
*/



const patternEvidence =
  await evaluatePatternEvidence({

    email,

    pattern:
      patternIntelligence.bestPattern?.pattern ?? "UNKNOWN",

    smtpValid:
      smtp.smtpValid,

    mailboxExists:
      smtp.mailboxExists,

    responseCode:
      smtp.responseCode,

    responseMessage:
      smtp.responseMessage ?? "",

    catchAll,

    source:
      "SMTP",

    verificationId

  });

const evidenceWeights =
  calculateEvidenceWeights({

    mxAvailable:
      smtp.mxAvailable,

    smtpValid:
      smtp.smtpValid,

    mailboxExists:
      smtp.mailboxExists,

    catchAll,

    retryRequired:
      smtp.retryRequired,

        providerDetected:
      Boolean(
        smtp.provider
      ),

    responseCode:
      smtp.responseCode,

    patternScore:
  patternIntelligence
    ?.bestPattern
    ?.reliabilityScore ?? null

  });

  const evidenceAnalysis =
  analyzeVerificationEvidence({

    mxAvailable:
      smtp.mxAvailable,

    responseCode:
      smtp.responseCode,

    smtpValid:
      smtp.smtpValid,

    mailboxExists:
      smtp.mailboxExists,

    catchAll,

    retryRequired:
      smtp.retryRequired,

    provider:
      smtp.provider

  });

  const decision =
  buildVerificationDecision({

    confidenceScore:
      confidence.score,

      patternReliabilityScore:
  patternIntelligence.bestPattern
    ?.reliabilityScore ?? null,


patternRiskLevel:
  patternIntelligence.bestPattern
    ?.riskLevel ?? undefined,


patternCompetitiveAdvantage:
  patternIntelligence.bestPattern
    ?.competitiveAdvantage ?? null,


patternTrend:
  patternIntelligence.bestPattern
    ?.trend ?? null,

    confidenceStatus:
      confidence.status,

    mailboxExists:
      smtp.mailboxExists,

    smtpValid:
      smtp.smtpValid,

    catchAll,

    responseCode:
      smtp.responseCode,

    mxAvailable:
      smtp.mxAvailable,

    retryRequired:
      smtp.retryRequired

  });

const recommendation =
  buildRecommendation({

    score:
      confidence.score,

    mailboxExists:
      smtp.mailboxExists,

    smtpValid:
      smtp.smtpValid,

    catchAll,

    retryRequired:
      smtp.retryRequired

  });


await verificationEventRepository.createEvent({

  verificationId,

  stage: "DECISION",

  status: "COMPLETED",

  metadata: {

    recommendation: recommendation.recommendation,

    action: recommendation.action

  }

});

  const verificationStatus =
  buildVerificationStatus({

    mxAvailable:
      smtp.mxAvailable,

    responseCode:
      smtp.responseCode,

    mailboxExists:
      smtp.mailboxExists,

    smtpValid:
      smtp.smtpValid,

    catchAll,

    retryRequired:
      smtp.retryRequired,

    smtpError:
      smtp.error

  });


  await verificationRepository.save({

  verificationId,

  requestId,

  email,

  domain,

  pattern,

  provider:
    smtp.provider,

  responseCode:
    smtp.responseCode,

  responseMessage:
    smtp.responseMessage,

  smtpValid:
    smtp.smtpValid,

  mailboxExists:
    smtp.mailboxExists,

  mxAvailable:
    smtp.mxAvailable,

  catchAll,

  retryRequired:
    smtp.retryRequired,

  retryReason:
    smtp.retryReason ?? null,

  confidenceScore:
    confidence.score,

  confidenceLevel:
    confidence.level,

  decision:
    decision.decision,

  recommendation:
    recommendation.recommendation,

  verificationStatus:
    verificationStatus.status

});

await createVerificationDecision({

    verificationId,

    email,

    decision:
        decision.decision,

    verificationStatus:
        verificationStatus.status,

    confidenceScore:
        confidence.score,

    confidenceLevel:
        confidence.level,


    reasonCodes:
        [
            decision.decision,
            verificationStatus.status
        ],


    evidenceSnapshot: {

    smtp: {

        responseCode:
            smtp.responseCode,

        mailboxExists:
            smtp.mailboxExists,

        smtpValid:
            smtp.smtpValid,

        mxAvailable:
            smtp.mxAvailable,

        provider:
            smtp.provider,

        retryRequired:
            smtp.retryRequired

    },


    catchAll,


    confidence: {

        score:
            confidence.score,

        level:
            confidence.level,

        status:
            confidence.status ?? null
    },


    patternIntelligence: {

        bestPattern:
            patternIntelligence.bestPattern ?? null

    },


        verificationStatus

    },


    engineVersion:
        "verification-engine-v1"

});

/*
==================================================
PERSIST PER-SIGNAL EVIDENCE
==================================================

Each analyzed signal (MX found, SMTP accepted/
rejected, catch-all detected, etc.) is a discrete,
traceable piece of evidence. verification_evidence
is the durable record of what was actually observed
— verification_events tracks stage progress, this
tracks individual signals within those stages.

Must run after verificationRepository.save() above:
verification_evidence.verification_id has a foreign
key to verification_results.verification_id.
==================================================
*/

await Promise.all(
  evidenceAnalysis.signals.map(signal =>
    evidenceRepository.save({

      verificationId,

      evidenceType: signal.direction,

      source: signal.source,

      signal: signal.name,

      value: signal.explanation,

      confidenceScore: signal.confidence,

      metadata: {
        severity: signal.severity
      }

    }).catch(error => {

      console.error(
        "[EvidenceRepository] Failed to persist signal evidence:",
        error
      );

    })
  )
);

/*
==================================================
IMMUTABLE AUDIT TRAIL
==================================================

Append-only records of what evidence was observed
and what the outcome of this attempt was. These do
not participate in scoring or decisions; failures
here must never break verification.
==================================================
*/

recordEvidence({

  email,

  domain,

  source: "SMTP",

  outcome:
    smtp.retryRequired
      ? "TEMPORARY"
      : smtp.mailboxExists
        ? "SUCCESS"
        : "FAILURE",

  responseCode:
    smtp.responseCode,

  responseMessage:
    smtp.responseMessage,

  smtpValid:
    smtp.smtpValid,

  mailboxExists:
    smtp.mailboxExists,

  catchAll,

  retryRequired:
    smtp.retryRequired,

  retryReason:
    smtp.retryReason,

  mxAvailable:
    smtp.mxAvailable,

  mxHosts:
    smtp.mxHosts,

  primaryMX:
    smtp.primaryMX,

  provider:
    smtp.provider,

  pattern,

  verificationId,

  requestId,

  errorMessage:
    smtp.error

}).catch(error => {

  console.error(
    "[EvidenceLedger] Failed to append evidence:",
    error
  );

});

recordVerificationAttempt({

  email,

  domain,

  method: "SMTP",

  outcome:
    verificationStatus.status === "TEMPORARY"
      ? "TEMPORARY_FAILURE"
      : verificationStatus.status === "NO_MX"
        ? "DNS_ERROR"
        : verificationStatus.status,

  success:
    verificationStatus.verificationPassed,

  responseCode:
    smtp.responseCode,

  responseMessage:
    smtp.responseMessage,

  mailboxExists:
    smtp.mailboxExists,

  smtpValid:
    smtp.smtpValid,

  catchAll,

  retryRequired:
    smtp.retryRequired,

  retryReason:
    smtp.retryReason,

  mxAvailable:
    smtp.mxAvailable,

  mxHosts:
    smtp.mxHosts,

  primaryMX:
    smtp.primaryMX,

  provider:
    smtp.provider,

  pattern,

  verificationId,

  requestId,

  errorMessage:
    smtp.error

}).catch(error => {

  console.error(
    "[VerificationAttemptHistory] Failed to record attempt:",
    error
  );

});

await verificationEventRepository.createEvent({

  verificationId,

  stage: "VERIFICATION",

  status: "COMPLETED",

  metadata: {

    verificationStatus,

    catchAll,

    retryRequired: smtp.retryRequired,

    confidence: confidence.score,

    recommendation:
    recommendation.recommendation,

  action:
    recommendation.action

  }

});

  return {

    success:true,

    email,

    domain,

    verificationId,

    requestId,

    pattern,


    verificationStatus,


   smtp:{

  responseCode:
    smtp.responseCode,

  responseMessage:
    smtp.responseMessage,

  mailboxExists:
    smtp.mailboxExists,

  smtpValid:
    smtp.smtpValid,

  mxAvailable:
    smtp.mxAvailable,

  mxHosts:
    smtp.mxHosts,

  primaryMX:
    smtp.primaryMX,

  provider:
    smtp.provider,

  retryRequired:
    smtp.retryRequired,

  retryReason:
    smtp.retryReason,

  error:
    smtp.error

},

    catchAll,


    retryRequired:
      smtp.retryRequired,


    retryReason:
        null,


    patternEvidence:{

      evaluated:false,

      recorded:false,

      outcome:null,

      reasonCode:null

    },


patternIntelligence: {

  available:
    Boolean(
      patternIntelligence.bestPattern
    ),

  score:
    patternIntelligence.bestPattern
      ?.reliabilityScore ?? null,

  successRate:
    patternIntelligence.bestPattern
      ?.successRate ?? null,

  attempts:
    patternIntelligence.bestPattern
      ?.attempts ?? 0,

  recommendation:
    patternIntelligence.bestPattern
      ?.recommendation ?? null,

  riskLevel:
    patternIntelligence.bestPattern?.riskLevel ?? null,

  evidenceSummary: {
    outcome:
      patternEvidence.outcome,

    reasonCode:
      patternEvidence.reasonCode,

    recorded:
      patternEvidence.recorded
  }

},

  intelligence: {

  score:
    confidence.score,

  level:
    confidence.level,

  status:
    verificationStatus.status,

  evidence: {

    summary:
      evidenceAnalysis.summary,

    signals:
      evidenceAnalysis.signals
  },

  evidenceWeights,

  decision,

  recommendation
},

  error:
    smtp.error

};

}
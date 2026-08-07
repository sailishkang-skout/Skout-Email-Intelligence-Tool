import { randomUUID } from "node:crypto";

import { getMX } from "./dnsCache.js";
import { verifySMTP } from "./smtpChecker.js";
import { checkCatchAll } from "./catchAllChecker.js";

import {
  calculateEvidenceConfidence
} from "./confidenceEngine.js";

import {
  buildVerificationDecision,
  type VerificationDecisionResult
} from "./verificationDecisionEngine.js";

import {
  recordTimelineEvent
} from "./evidenceTimeline.js";

import {
  recordEvidence
} from "./evidenceLedger.js";

import {
  recordVerificationAttempt
} from "./verificationAttemptHistory.js";

import {
  getPatternHistory
} from "./patternHistory.js";

import {
  evaluatePatternEvidence
} from "./patternEvidence.js";

import {
  getPatternIntelligence
} from "./patternIntelligence.js";

import {
  buildVerificationStatus,
  type VerificationStatusResult
} from "../types/verificationStatus.js";

import {
  analyzeVerificationEvidence,
  type EvidenceSignal
} from "./evidenceAnalyzer.js";

import {
  calculateEvidenceWeights
} from "./evidenceWeighting.js";

import type {
  WeightedEvidence
} from "./evidenceWeighting.js";

import {
  collectVerificationEvidence
} from "./evidenceCollector.js";

import {
  buildEvidenceGraph
} from "./evidenceGraph.js";

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

import {
  runVerificationLifecycle
} from "./verificationLifecycle.js";



/*
==================================================
NORMALIZED TYPES
==================================================
*/



interface NormalizedPatternIntelligence {

  available:boolean;

  score:number|null;

  successRate:number|null;

  attempts:number;

  recommendation:string|null;

}



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
PATTERN INTELLIGENCE NORMALIZER
==================================================
*/



function normalizePatternIntelligence(
  raw:unknown
):NormalizedPatternIntelligence|null {


  if(
    !raw ||
    typeof raw !== "object"
  ){

    return null;

  }


  const value =
    raw as Record<string,unknown>;



  return {


    available:true,


    score:
      typeof value.score === "number"
        ? value.score
        : null,


    successRate:
      typeof value.successRate === "number"
        ? value.successRate
        : null,


    attempts:
      typeof value.attempts === "number"
        ? value.attempts
        : 0,


    recommendation:
      typeof value.recommendation === "string"
        ? value.recommendation
        : null

  };

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
PATTERN HISTORY
==================================================
*/

async function getHistoricalPatternEvidence(
  domain:string,
  pattern:string|null
){

  if(!pattern){

    return {
      attempts:0,
      successes:0,
      failures:0,
      successRate:null
    };

  }


  try {

    const history =
      await getPatternHistory(
        normalizeDomain(domain),
        pattern.trim().toLowerCase()
      );


    if(!history){

      return {
        attempts:0,
        successes:0,
        failures:0,
        successRate:null
      };

    }


    const attempts =
      Number(history.attempts) || 0;


    const successes =
      Number(history.successes) || 0;


    const failures =
      Number(history.failures) || 0;


    return {

      attempts,

      successes,

      failures,

      successRate:
        attempts > 0
          ? successes / attempts
          : null

    };


  }
  catch(error){

    console.error(
      "[PatternHistory] Failed reading history:",
      error
    );


    return {

      attempts:0,

      successes:0,

      failures:0,

      successRate:null

    };

  }

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

  console.log(
  "[EVENT TEST] Creating START event",
  {
    verificationId,
    email,
    domain
  }
);

verificationEventRepository.createEvent({

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



  let smtpError:string|null = null;



  /*
  ==================================================
  MX + SMTP VERIFICATION
  ==================================================
  */
verificationEventRepository.createEvent({

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


verificationEventRepository.createEvent({

  verificationId,

  stage: "MX",

  status: "COMPLETED",

  metadata: {

    mxAvailable: smtp.mxAvailable,

    hosts: smtp.mxHosts

  }

});

    await recordTimelineEvent({

      verificationId,

      stage:
        "DNS",

      event:
        "MX_LOOKUP_COMPLETED",

      data:{

        domain,

        mxHosts,

        mxAvailable:
          smtp.mxAvailable

      }

    });

verificationEventRepository.createEvent({

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
    smtp.primaryMX!
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



      await recordTimelineEvent({

        verificationId,

        stage:
          "SMTP",

        event:
          "SMTP_VERIFICATION_COMPLETED",

        data:{

          mailboxExists:
            smtp.mailboxExists,

          smtpValid:
            smtp.smtpValid,

          responseCode:
            smtp.responseCode

        }

      });

        }

verificationEventRepository.createEvent({

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

    verificationEventRepository.createEvent({

  verificationId,

  stage: "SMTP",

  status: "FAILED",

  metadata: {

    error: smtpError,

     retryRequired:
        true

  }

});

  await recordTimelineEvent({

    verificationId,

    stage:
      "SMTP",

    event:
      "VERIFICATION_ERROR",

    data:{
      error:
        smtpError
    }

  });
}

/*
==================================================
CATCH ALL VERIFICATION
==================================================
*/

verificationEventRepository.createEvent({

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
catch(error){

  catchAll = false;

}

verificationEventRepository.createEvent({

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
verificationEventRepository.createEvent({

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
verificationEventRepository.createEvent({

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
  getPatternIntelligence(
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


console.log(
  "DECISION EVENT CREATED",
  "STARTED"
);

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

  await runVerificationLifecycle({

  email,

domain:
  extractDomain(email),

  confidenceScore:
    confidence.score,


  smtpValid:
    smtp.smtpValid,


  mailboxExists:
    smtp.mailboxExists,


  catchAll,


  disposable:
    false,


  patternRiskLevel:
    patternIntelligence.bestPattern
      ?.riskLevel ?? null,


  patternScore:
  patternIntelligence.bestPattern
    ?.reliabilityScore ?? undefined

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


console.log(
  "DECISION EVENT CREATED",
  "COMPLETED"
);

verificationEventRepository.createEvent({

  verificationId,

  stage: "DECISION",

  status: "COMPLETED",

  metadata: {

    recommendation: recommendation.recommendation,

    action: recommendation.action

  }

});

const evidenceGraph =
  buildEvidenceGraph({

    evidence:
      evidenceWeights.evidence,

    confidenceScore:
      confidence.score,

    confidenceLevel:
      confidence.level,

    decision:
      decision.decision,

    recommendation:
      recommendation.action

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

  verificationRepository.save({

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

  verificationRepository.save({
  verificationId,

  email,

  domain,

  pattern:

    pattern ?? null,

  verificationStatus:

    verificationStatus.status,

  decision:

    decision.decision,

  confidenceScore:

    confidence.score,

  recommendation:

    recommendation.recommendation,

  smtpValid:

    smtp.smtpValid,

  mailboxExists:

    smtp.mailboxExists,

  catchAll,

  retryRequired:

    smtp.retryRequired,

  responseCode:

    smtp.responseCode,

  provider:

    smtp.provider
});

verificationEventRepository.createEvent({

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
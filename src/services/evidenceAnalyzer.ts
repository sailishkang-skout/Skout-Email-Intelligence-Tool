/*
==================================================
EVIDENCE ANALYZER

Purpose:

Convert raw verification evidence into
human and machine understandable signals.

Does NOT:
- calculate confidence
- change verification status
- write storage

==================================================
*/


export type EvidenceSignalDirection =
  | "POSITIVE"
  | "NEGATIVE"
  | "NEUTRAL";


export type EvidenceSignalSeverity =
  | "LOW"
  | "MEDIUM"
  | "HIGH"
  | "CRITICAL";


export interface EvidenceSignal {

  name:string;

  source:
    | "DNS"
    | "SMTP"
    | "CATCH_ALL"
    | "PATTERN"
    | "SYSTEM";

  direction:
    EvidenceSignalDirection;

  severity:
    EvidenceSignalSeverity;

  confidence:number;

  explanation:string;

}


export interface EvidenceAnalysisInput {

  mxAvailable:boolean;

  responseCode:number|null;

  smtpValid:boolean;

  mailboxExists:boolean;

  catchAll:boolean;

  retryRequired:boolean;

  provider?:string|null;

}



export interface EvidenceAnalysisResult {

  summary:string;

  signals:EvidenceSignal[];

}




export function analyzeVerificationEvidence(
  input:EvidenceAnalysisInput
):EvidenceAnalysisResult {


  const signals:EvidenceSignal[] = [];



  /*
  ================================================
  MX
  ================================================
  */

  if(input.mxAvailable){

    signals.push({

      name:
        "MX_RECORD_FOUND",

      source:
        "DNS",

      direction:
        "POSITIVE",

      severity:
        "LOW",

      confidence:
        100,

      explanation:
        "Domain has valid mail exchange records."

    });

  }
  else{

    signals.push({

      name:
        "NO_MX_RECORD",

      source:
        "DNS",

      direction:
        "NEGATIVE",

      severity:
        "CRITICAL",

      confidence:
        100,

      explanation:
        "Domain has no valid mail server."

    });

  }




  /*
  ================================================
  SMTP
  ================================================
  */


  if(
    input.responseCode !== null &&
    input.responseCode >=500 &&
    input.responseCode <600
  ){

    signals.push({

      name:
        "SMTP_MAILBOX_REJECTED",

      source:
        "SMTP",

      direction:
        "NEGATIVE",

      severity:
        "CRITICAL",

      confidence:
        100,

      explanation:
        "SMTP server permanently rejected recipient."

    });

  }



  if(
    input.smtpValid &&
    input.mailboxExists
  ){

    signals.push({

      name:
        "SMTP_MAILBOX_CONFIRMED",

      source:
        "SMTP",

      direction:
        "POSITIVE",

      severity:
        "HIGH",

      confidence:
        100,

      explanation:
        "SMTP server confirmed mailbox existence."

    });

  }




  /*
  ================================================
  CATCH ALL
  ================================================
  */


  if(input.catchAll){

    signals.push({

      name:
        "CATCH_ALL_DOMAIN",

      source:
        "CATCH_ALL",

      direction:
        "NEGATIVE",

      severity:
        "HIGH",

      confidence:
        95,

      explanation:
        "Domain accepts arbitrary recipients."

    });

  }



  /*
  ================================================
  RETRY
  ================================================
  */


  if(input.retryRequired){

    signals.push({

      name:
        "TEMPORARY_FAILURE",

      source:
        "SMTP",

      direction:
        "NEGATIVE",

      severity:
        "MEDIUM",

      confidence:
        80,

      explanation:
        "Verification requires retry."

    });

  }




  let summary =
    "Evidence analyzed";


  const negative =
    signals.find(
      s =>
        s.direction==="NEGATIVE"
    );


  if(negative){

    summary =
      negative.explanation;

  }




  return {

    summary,

    signals

  };

}
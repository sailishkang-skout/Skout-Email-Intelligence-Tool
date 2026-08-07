import type {
  EvidenceLedgerInput
} from "./evidenceLedger.js";

import type {
  WeightedEvidenceInput
} from "./evidenceWeighting.js";


/*
==================================================
EVIDENCE COLLECTOR
==================================================

Purpose:

Convert verification outputs into a normalized
evidence packet.

Responsibilities:

- collect SMTP evidence
- collect DNS evidence
- collect catch-all evidence
- collect pattern evidence
- create weighted evidence signals

Does NOT:

- calculate confidence
- make decisions
- recommend sending

==================================================
*/


/*
==================================================
TYPES
==================================================
*/


export interface EvidencePacket {

  email:string;

  domain:string;


  smtp:{

    responseCode:number|null;

    responseMessage:string|null;

    mailboxExists:boolean;

    smtpValid:boolean;

    mxAvailable:boolean;

    mxHosts:string[];

    primaryMX:string|null;

    provider:string|null;

  };


  catchAll:boolean;

  retryRequired:boolean;

  retryReason:string|null;

  pattern:string|null;


  signals:
    WeightedEvidenceInput[];


  ledgerEvents:
    EvidenceLedgerInput[];

}



/*
==================================================
INPUT
==================================================
*/


export interface EvidenceCollectorSMTPInput {

  responseCode:number|null;

  responseMessage:string|null;

  mailboxExists:boolean;

  smtpValid:boolean;

  mxAvailable:boolean;

  mxHosts:string[];

  primaryMX:string|null;

  provider:string|null;

  retryRequired:boolean;

}



export interface EvidenceCollectorInput {

  email:string;

  domain:string;

  smtp:
    EvidenceCollectorSMTPInput;

  catchAll:boolean;

  retryReason?:string|null;

  pattern?:string|null;

}



/*
==================================================
COLLECT
==================================================
*/


export function collectVerificationEvidence(
  input:EvidenceCollectorInput
):EvidencePacket {


  const ledgerEvents:
    EvidenceLedgerInput[] = [];


  const signals:
    WeightedEvidenceInput[] = [];



  /*
  ==========================================
  SMTP LEDGER
  ==========================================
  */


  ledgerEvents.push({

    email:
      input.email,

    domain:
      input.domain,

    source:
      "SMTP",

    outcome:
      input.smtp.mailboxExists
        ? "SUCCESS"
        : "FAILURE",

    responseCode:
      input.smtp.responseCode,

    responseMessage:
      input.smtp.responseMessage,

    smtpValid:
      input.smtp.smtpValid,

    mailboxExists:
      input.smtp.mailboxExists,

    mxAvailable:
      input.smtp.mxAvailable,

    mxHosts:
      input.smtp.mxHosts,

    primaryMX:
      input.smtp.primaryMX,

    provider:
      input.smtp.provider

  });



  /*
  ==========================================
  SMTP SIGNALS
  ==========================================
  */


  if(input.smtp.mailboxExists){

    signals.push({

      type:
        "MAILBOX_EXISTS",

      description:
        "SMTP server confirmed mailbox existence.",

      weight:
        50,

      positive:
        true

    });

  }



  if(
    input.smtp.responseCode !== null &&
    input.smtp.responseCode >= 500
  ){

    signals.push({

      type:
        "SMTP_FAILURE",

      description:
        "SMTP permanently rejected mailbox.",

      weight:
        -80,

      positive:
        false

    });

  }



  /*
  ==========================================
  MX SIGNALS
  ==========================================
  */


  if(input.smtp.mxAvailable){

    signals.push({

      type:
        "MX_PRESENT",

      description:
        "Domain has valid MX records.",

      weight:
        20,

      positive:
        true

    });

  }
  else {

    signals.push({

      type:
        "MX_MISSING",

      description:
        "Domain has no valid MX records.",

      weight:
        -50,

      positive:
        false

    });

  }



  /*
  ==========================================
  CATCH ALL
  ==========================================
  */


  if(input.catchAll){

    signals.push({

      type:
        "CATCH_ALL",

      description:
        "Domain accepts unknown recipients.",

      weight:
        -30,

      positive:
        false

    });



    ledgerEvents.push({

      email:
        input.email,

      domain:
        input.domain,

      source:
        "CATCH_ALL",

      outcome:
        "UNKNOWN",

      catchAll:
        true

    });

  }



  /*
  ==========================================
  PATTERN
  ==========================================
  */


  if(input.pattern){

    signals.push({

      type:
        "PATTERN",

      description:
        `Pattern ${input.pattern} detected.`,

      weight:
        10,

      positive:
        true

    });



    ledgerEvents.push({

      email:
        input.email,

      domain:
        input.domain,

      source:
        "PATTERN",

      outcome:
        "UNKNOWN",

      pattern:
        input.pattern

    });

  }



  /*
  ==========================================
  RETURN
  ==========================================
  */


  return {


    email:
      input.email,


    domain:
      input.domain,


    smtp:{

      responseCode:
        input.smtp.responseCode,

      responseMessage:
        input.smtp.responseMessage,

      mailboxExists:
        input.smtp.mailboxExists,

      smtpValid:
        input.smtp.smtpValid,

      mxAvailable:
        input.smtp.mxAvailable,

      mxHosts:
        input.smtp.mxHosts,

      primaryMX:
        input.smtp.primaryMX,

      provider:
        input.smtp.provider

    },


    catchAll:
      input.catchAll,


    retryRequired:
      input.smtp.retryRequired,


    retryReason:
      input.retryReason ?? null,


    pattern:
      input.pattern ?? null,


    signals,


    ledgerEvents

  };

}
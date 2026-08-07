import {
  fuseEvidence
} from "./evidenceFusionEngine.js";

import {
  evaluateRisk
} from "./riskEngine.js";

import {
  saveVerification
} from "./verificationRepository.js";



export interface VerificationLifecycleInput {

  email:string;

  domain:string;

  confidenceScore:number;

  smtpValid:boolean;

  mailboxExists:boolean;

  catchAll:boolean;

  disposable:boolean;

  patternRiskLevel?:
    | "CRITICAL"
    | "HIGH"
    | "MEDIUM"
    | "LOW"
    | "VERY_LOW"
    | null;


  domainReputationScore?:number;

  organizationTrustScore?:number;

  emailHistoryScore?:number;

  providerScore?:number;

  patternScore?:number;

}



export async function runVerificationLifecycle(
 input:VerificationLifecycleInput
){


 const evidence =
   fuseEvidence({

    confidenceScore:
      input.confidenceScore,

    smtpValid:
      input.smtpValid,

    mailboxExists:
      input.mailboxExists,

    catchAll:
      input.catchAll,


    domainReputationScore:
      input.domainReputationScore,


    organizationTrustScore:
      input.organizationTrustScore,


    emailHistoryScore:
      input.emailHistoryScore,


    providerScore:
      input.providerScore,


    patternScore:
      input.patternScore

   });



 const risk =
   evaluateRisk({

    evidenceScore:
      evidence.score,

    smtpValid:
      input.smtpValid,

    mailboxExists:
      input.mailboxExists,

    catchAll:
      input.catchAll,

    disposable:
      input.disposable,

    patternRiskLevel:
      input.patternRiskLevel

   });



 const decision =
   risk.decision;



 saveVerification({

   email:
     input.email,

   domain:
     input.domain,

   confidenceScore:
     evidence.score,

   decision,

   evidence:{
     evidence,
     risk
   }

 });



 return {

   email:
     input.email,

   evidence,

   risk,

   decision

 };

}
import type {
  VerificationStatusResult
} from "./verificationStatus.js";

import type {
  EvidenceSignal
} from "../services/evidenceAnalyzer.js";

import type {
  WeightedEvidence
} from "../services/evidenceWeighting.js";

import type {
  VerificationDecisionResult
} from "../services/verificationDecisionEngine.js";

import type {
  NormalizedSMTPResult
} from "./smtp.js";


export interface VerifyEmailResult {

  success:boolean;

  email:string;

  domain:string;

  verificationId:string;

  requestId:string|null;

  pattern:string|null;

  verificationStatus:VerificationStatusResult;

  smtp:NormalizedSMTPResult;

  catchAll:boolean;

  retryRequired:boolean;

  retryReason:string|null;

  patternEvidence:{

    evaluated:boolean;

    recorded:boolean;

    outcome:
      | "SUCCESS"
      | "FAILURE"
      | "NOT_RECORDED"
      | null;

    reasonCode:string|null;

  };

 patternIntelligence: {
  available: boolean;

  score: number | null;

  successRate: number | null;

  attempts: number;

  recommendation: string | null;

  riskLevel:
    | "VERY_LOW"
    | "LOW"
    | "MEDIUM"
    | "HIGH"
    | "CRITICAL"
    | null;

  evidenceSummary?: {
    outcome: string | null;
    reasonCode: string | null;
    recorded: boolean;
  };

  evidence?: {
    outcome?: string | null;

    confidence?: number | null;

    reason?: string | null;

    pattern?: string | null;

    evaluated?: boolean;

    recorded?: boolean;

    reasonCode?: string | null;
  };

}
 | null;

  intelligence:{

    score:number;

    level:string;

    status:string;

    evidence:{

      summary:string;

      signals:EvidenceSignal[];

    };

    evidenceWeights:{

      totalPositive:number;

      totalNegative:number;

      netWeight:number;

      strongestPositive:WeightedEvidence|null;

      strongestNegative:WeightedEvidence|null;

      evidence:WeightedEvidence[];

    };

    decision:VerificationDecisionResult;

    recommendation:{

      recommendation:
        | "SAFE_TO_SEND"
        | "DO_NOT_SEND"
        | "RETRY"
        | "REVIEW";

      action:
        | "USE_EMAIL"
        | "DO_NOT_USE"
        | "RETRY_VERIFICATION"
        | "MANUAL_REVIEW";

      reason:string;

    };

  };

  error:string|null;

}
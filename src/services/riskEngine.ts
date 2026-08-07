export type RiskDecision =
  | "SAFE"
  | "RISKY"
  | "BLOCK"
  | "REVIEW";


export interface RiskEngineInput {

  evidenceScore:number;

  catchAll:boolean;

  smtpValid:boolean;

  mailboxExists:boolean;

  disposable:boolean;

  patternRiskLevel?:
    | "CRITICAL"
    | "HIGH"
    | "MEDIUM"
    | "LOW"
    | "VERY_LOW"
    | null;

  bounceRisk?:number;

}


export interface RiskEngineResult {

  decision:RiskDecision;

  riskScore:number;

  reasons:string[];

}



export function evaluateRisk(
  input:RiskEngineInput
):RiskEngineResult {


  let riskScore = 0;

  const reasons:string[] = [];



  /*
  Verification failures
  */

  if(!input.smtpValid){

    riskScore += 30;

    reasons.push(
      "SMTP validation failed"
    );

  }


  if(!input.mailboxExists){

    riskScore += 35;

    reasons.push(
      "Mailbox not confirmed"
    );

  }



  /*
  Domain risks
  */

  if(input.catchAll){

    riskScore += 25;

    reasons.push(
      "Catch-all domain"
    );

  }


  if(input.disposable){

    riskScore += 40;

    reasons.push(
      "Disposable email provider"
    );

  }



  /*
  Pattern intelligence
  */

  if(
    input.patternRiskLevel === "CRITICAL"
  ){

    riskScore += 50;

    reasons.push(
      "Critical pattern risk"
    );

  }


  if(
    input.patternRiskLevel === "HIGH"
  ){

    riskScore += 30;

    reasons.push(
      "High pattern risk"
    );

  }



  if(
    (input.bounceRisk ?? 0) > 50
  ){

    riskScore += 20;

    reasons.push(
      "High bounce probability"
    );

  }



  /*
  Evidence quality
  */

  if(input.evidenceScore >= 85){

    riskScore -= 20;

    reasons.push(
      "Strong verification evidence"
    );

  }



  riskScore = Math.max(
    0,
    Math.min(
      100,
      riskScore
    )
  );



  let decision:RiskDecision;


  if(riskScore >= 75){

    decision = "BLOCK";

  }
  else if(riskScore >= 50){

    decision = "REVIEW";

  }
  else if(riskScore >= 25){

    decision = "RISKY";

  }
  else {

    decision = "SAFE";

  }



  return {

    decision,

    riskScore,

    reasons

  };

}
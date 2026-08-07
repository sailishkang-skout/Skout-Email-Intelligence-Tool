export type Recommendation =
  | "SAFE_TO_SEND"
  | "USE_WITH_CAUTION"
  | "DO_NOT_USE";



export interface RecommendationResult {

  recommendation: Recommendation;

  action:
    | "USE_EMAIL"
    | "REVIEW"
    | "REJECT";

  reason:string;

}



export function generateRecommendation(
  score:number,
  status:string,
  catchAll:boolean = false
):RecommendationResult {



  /*
    Hard rejection
  */

  if(status === "INVALID"){

    return {

      recommendation:
        "DO_NOT_USE",

      action:
        "REJECT",

      reason:
        "Email failed verification"

    };

  }




  /*
    Catch all domains
  */

  if(catchAll === true){

    return {

      recommendation:
        "USE_WITH_CAUTION",

      action:
        "REVIEW",

      reason:
        "Domain accepts unknown recipients"

    };

  }





  /*
    High confidence
  */

  if(score >= 90){

    return {

      recommendation:
        "SAFE_TO_SEND",

      action:
        "USE_EMAIL",

      reason:
        "Email verification signals are strong"

    };

  }





  /*
    Medium confidence
  */

  if(score >= 70){

    return {

      recommendation:
        "USE_WITH_CAUTION",

      action:
        "REVIEW",

      reason:
        "Verification confidence is moderate"

    };

  }





  return {

    recommendation:
      "DO_NOT_USE",

    action:
      "REJECT",

    reason:
      "Verification confidence too low"

  };


}
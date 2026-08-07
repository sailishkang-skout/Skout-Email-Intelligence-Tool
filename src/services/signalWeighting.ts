export interface VerificationSignals {

  patternScore?: number;

  smtpValid?: boolean;

  mailboxExists?: boolean;

  provider?: string;

  catchAll?: boolean;

  retryRequired?: boolean;

}



export interface SignalScore {

  totalScore: number;

  breakdown: {

    signal: string;

    points: number;

    reason: string;

  }[];

}



export function calculateSignalWeight(
  signals: VerificationSignals
): SignalScore {


  let score = 0;


  const breakdown:
    SignalScore["breakdown"] = [];



  /*
    SMTP acceptance
  */

  if (
    signals.smtpValid === true
  ) {

    score += 40;


    breakdown.push({

      signal:
        "SMTP_ACCEPTED",

      points:
        40,

      reason:
        "SMTP server accepted recipient"

    });

  }



  /*
    Mailbox existence
  */

  if (
    signals.mailboxExists === true
  ) {

    score += 25;


    breakdown.push({

      signal:
        "MAILBOX_EXISTS",

      points:
        25,

      reason:
        "Mailbox accepted during SMTP verification"

    });

  }



  /*
    Pattern confidence
  */

  if (
    typeof signals.patternScore === "number"
  ) {


    if (
      signals.patternScore >= 90
    ) {


      score += 20;


      breakdown.push({

        signal:
          "HIGH_PATTERN_MATCH",

        points:
          20,

        reason:
          "High confidence email naming pattern"

      });


    }

    else if (
      signals.patternScore >= 70
    ) {


      score += 10;


      breakdown.push({

        signal:
          "MEDIUM_PATTERN_MATCH",

        points:
          10,

        reason:
          "Medium confidence email pattern"

      });

    }

  }



  /*
    Known provider
  */

  if (
    signals.provider &&
    signals.provider !== "OTHER"
  ) {


    score += 10;


    breakdown.push({

      signal:
        "KNOWN_PROVIDER",

      points:
        10,

      reason:
        "Recognized email provider"

    });

  }




  /*
    Catch all penalty
  */

  if (
    signals.catchAll === true
  ) {


    score -= 25;


    breakdown.push({

      signal:
        "CATCH_ALL_DOMAIN",

      points:
        -25,

      reason:
        "Domain accepts unknown recipients"

    });

  }



  /*
    Retry penalty
  */

  if (
    signals.retryRequired === true
  ) {


    score -= 10;


    breakdown.push({

      signal:
        "SMTP_RETRY_REQUIRED",

      points:
        -10,

      reason:
        "SMTP response requires retry"

    });

  }



  /*
    Normalize
  */

  if(score > 100)
    score = 100;


  if(score < 0)
    score = 0;



  return {

    totalScore:
      score,

    breakdown

  };


}
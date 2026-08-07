export type SMTPStatus =
  | "VALID"
  | "INVALID"
  | "GREYLISTED"
  | "TEMPORARY_FAILURE"
  | "SERVER_ERROR"
  | "UNKNOWN";


export interface SMTPClassification {

  status: SMTPStatus;

  mailboxExists: boolean;

  retryRecommended: boolean;

  confidence: "high" | "medium" | "low";

  reason: string;

}


export function classifySMTPResponse(
  responseCode: number | null,
  responseMessage: string
): SMTPClassification {


  if (!responseCode) {

    return {
      status: "UNKNOWN",
      mailboxExists: false,
      retryRecommended: true,
      confidence: "low",
      reason: "No SMTP response code received",
    };

  }


  switch (responseCode) {


    // Successful recipient accepted
    case 250:
    case 251:

      return {
        status: "VALID",
        mailboxExists: true,
        retryRecommended: false,
        confidence: "high",
        reason: "SMTP server accepted recipient",
      };


    // Permanent mailbox rejection
    case 550:
    case 551:
    case 553:

      return {
        status: "INVALID",
        mailboxExists: false,
        retryRecommended: false,
        confidence: "high",
        reason: "Mailbox rejected by SMTP server",
      };


    // Greylisting / temporary rejection
    case 421:
    case 450:
    case 451:
    case 452:

      return {
        status: "GREYLISTED",
        mailboxExists: false,
        retryRecommended: true,
        confidence: "medium",
        reason: "Temporary SMTP rejection detected",
      };


    // Server-side failure
    case 500:
    case 501:
    case 502:
    case 503:
    case 504:

      return {
        status: "SERVER_ERROR",
        mailboxExists: false,
        retryRecommended: true,
        confidence: "low",
        reason: "SMTP server command failure",
      };


    default:

      return {
        status: "UNKNOWN",
        mailboxExists: false,
        retryRecommended: true,
        confidence: "low",
        reason: `Unhandled SMTP response ${responseCode}`,
      };

  }

}
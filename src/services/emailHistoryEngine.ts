export interface EmailHistoryInput {
  successfulVerifications: number;
  failedVerifications: number;
  bounceRate: number;
}

export interface EmailHistoryResult {
  score: number;
  trend: "IMPROVING" | "STABLE" | "DECLINING";
}

export function evaluateEmailHistory(
  input: EmailHistoryInput
): EmailHistoryResult {

  let score = 50;

  score += input.successfulVerifications * 2;
  score -= input.failedVerifications * 3;
  score -= input.bounceRate * 20;

  score = Math.max(0, Math.min(100, score));

  let trend: "IMPROVING" | "STABLE" | "DECLINING";

  if (score >= 75) {
    trend = "IMPROVING";
  } else if (score >= 40) {
    trend = "STABLE";
  } else {
    trend = "DECLINING";
  }

  return {
    score,
    trend
  };
}
export interface DomainReputationInput {
  domainAgeYears?: number | null;
  hasDMARC?: boolean;
  hasSPF?: boolean;
  hasDKIM?: boolean;
  disposable?: boolean;
  freeProvider?: boolean;
  roleBased?: boolean;
}

export interface DomainReputationResult {
  score: number;
  level: "HIGH" | "MEDIUM" | "LOW";
  reasons: string[];
}

export function evaluateDomainReputation(
  input: DomainReputationInput
): DomainReputationResult {

  let score = 50;
  const reasons: string[] = [];

  if (input.hasSPF) {
    score += 10;
    reasons.push("SPF present");
  }

  if (input.hasDKIM) {
    score += 10;
    reasons.push("DKIM present");
  }

  if (input.hasDMARC) {
    score += 10;
    reasons.push("DMARC present");
  }

  if ((input.domainAgeYears ?? 0) >= 5) {
    score += 10;
    reasons.push("Mature domain");
  }

  if (input.disposable) {
    score -= 40;
    reasons.push("Disposable provider");
  }

  if (input.roleBased) {
    score -= 5;
    reasons.push("Role account");
  }

  score = Math.max(0, Math.min(100, score));

  return {
    score,
    level:
      score >= 80
        ? "HIGH"
        : score >= 50
        ? "MEDIUM"
        : "LOW",
    reasons
  };
}
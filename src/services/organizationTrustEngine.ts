export interface OrganizationTrustInput {
  companyExists: boolean;
  websiteReachable: boolean;
  linkedinCompany: boolean;
  employeeCount?: number | null;
  domainAgeYears?: number | null;
}

export interface OrganizationTrustResult {
  score: number;
  level: "HIGH" | "MEDIUM" | "LOW";
  reasons: string[];
}

export function evaluateOrganizationTrust(
  input: OrganizationTrustInput
): OrganizationTrustResult {

  let score = 0;
  const reasons: string[] = [];

  if (input.companyExists) {
    score += 30;
    reasons.push("Registered company");
  }

  if (input.websiteReachable) {
    score += 20;
    reasons.push("Website reachable");
  }

  if (input.linkedinCompany) {
    score += 20;
    reasons.push("LinkedIn company profile");
  }

  if ((input.employeeCount ?? 0) >= 10) {
    score += 15;
    reasons.push("Established workforce");
  }

  if ((input.domainAgeYears ?? 0) >= 5) {
    score += 15;
    reasons.push("Mature domain");
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
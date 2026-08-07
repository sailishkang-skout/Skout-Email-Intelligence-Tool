export type EmailProviderType =
  | "GOOGLE"
  | "MICROSOFT"
  | "ZOHO"
  | "YAHOO"
  | "FASTMAIL"
  | "PROTON"
  | "CUSTOM"
  | "UNKNOWN";

export interface ProviderIntelligenceResult {
  provider: EmailProviderType;
  score: number;
  supportsSMTP: boolean;
  enterprise: boolean;
}

export function detectProvider(
  mxHosts: string[]
): ProviderIntelligenceResult {

  const hosts = mxHosts.map(h => h.toLowerCase());

  if (hosts.some(h => h.includes("google"))) {
    return {
      provider: "GOOGLE",
      score: 95,
      supportsSMTP: true,
      enterprise: true
    };
  }

  if (hosts.some(h => h.includes("outlook") || h.includes("protection"))) {
    return {
      provider: "MICROSOFT",
      score: 95,
      supportsSMTP: true,
      enterprise: true
    };
  }

  if (hosts.some(h => h.includes("zoho"))) {
    return {
      provider: "ZOHO",
      score: 90,
      supportsSMTP: true,
      enterprise: true
    };
  }

  if (hosts.some(h => h.includes("yahoodns"))) {
    return {
      provider: "YAHOO",
      score: 85,
      supportsSMTP: true,
      enterprise: false
    };
  }

  if (hosts.some(h => h.includes("fastmail"))) {
    return {
      provider: "FASTMAIL",
      score: 85,
      supportsSMTP: true,
      enterprise: false
    };
  }

  if (hosts.some(h => h.includes("proton"))) {
    return {
      provider: "PROTON",
      score: 90,
      supportsSMTP: true,
      enterprise: false
    };
  }

  if (hosts.length > 0) {
    return {
      provider: "CUSTOM",
      score: 70,
      supportsSMTP: true,
      enterprise: true
    };
  }

  return {
    provider: "UNKNOWN",
    score: 0,
    supportsSMTP: false,
    enterprise: false
  };
}
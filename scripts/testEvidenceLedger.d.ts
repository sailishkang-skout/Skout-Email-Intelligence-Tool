export type EvidenceSource = "SMTP" | "DNS" | "CATCH_ALL" | "PATTERN" | "API" | "MANUAL" | "IMPORT" | "OTHER";
export type EvidenceOutcome = "SUCCESS" | "FAILURE" | "UNKNOWN" | "TEMPORARY" | "NOT_RUN";
export interface EvidenceLedgerInput {
    email: string;
    domain?: string | null;
    source: EvidenceSource;
    outcome: EvidenceOutcome;
    responseCode?: number | null;
    responseMessage?: string | null;
    smtpValid?: boolean | null;
    mailboxExists?: boolean | null;
    catchAll?: boolean | null;
    retryRequired?: boolean | null;
    retryReason?: string | null;
    mxAvailable?: boolean | null;
    mxHosts?: string[];
    primaryMX?: string | null;
    provider?: string | null;
    pattern?: string | null;
    patternEvidenceRecorded?: boolean | null;
    patternEvidenceOutcome?: "SUCCESS" | "FAILURE" | "NOT_RECORDED" | null;
    patternAttempts?: number | null;
    patternSuccesses?: number | null;
    patternFailures?: number | null;
    verificationId?: string | null;
    requestId?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    metadata?: Record<string, unknown>;
    rawEvidence?: unknown;
}
export interface EvidenceLedgerRecord extends EvidenceLedgerInput {
    id: string;
    timestamp: string;
    version: 1;
    email: string;
    domain: string | null;
}
export declare function recordEvidence(input: EvidenceLedgerInput): Promise<EvidenceLedgerRecord>;
export declare function getEvidenceRecords(options?: {
    email?: string;
    domain?: string;
    source?: EvidenceSource;
    limit?: number;
}): Promise<EvidenceLedgerRecord[]>;
export declare function getEmailEvidenceHistory(email: string, limit?: number): Promise<EvidenceLedgerRecord[]>;
export declare function getDomainEvidenceHistory(domain: string, limit?: number): Promise<EvidenceLedgerRecord[]>;
export declare function getLatestEvidence(email: string): Promise<EvidenceLedgerRecord | null>;
export declare function countEvidence(email?: string): Promise<number>;
//# sourceMappingURL=testEvidenceLedger.d.ts.map
import { randomUUID } from "node:crypto";

import { getDatabase } from "../database/database.js";

/*
==================================================
EVIDENCE LEDGER
==================================================

Purpose:

Store immutable verification observations.

Architecture:

Evidence Ledger
    -> what happened

Confidence Engine
    -> how much we trust it

Recommendation Engine
    -> what Skout should do

This service does NOT:

- calculate confidence
- rank candidates
- recommend sending
- mutate pattern intelligence

Storage: PostgreSQL (evidence_ledger table). Previously
a local JSONL file — that doesn't survive container
restarts and isn't visible across replicas, so it
can't be the record of what evidence was actually
observed in a horizontally-scaled deployment.
==================================================
*/

/*
==================================================
TYPES
==================================================
*/

export type EvidenceSource =
  | "SMTP"
  | "DNS"
  | "CATCH_ALL"
  | "PATTERN"
  | "API"
  | "MANUAL"
  | "IMPORT"
  | "OTHER";

export type EvidenceOutcome =
  | "SUCCESS"
  | "FAILURE"
  | "UNKNOWN"
  | "TEMPORARY"
  | "NOT_RUN";

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

  patternEvidenceOutcome?:
    | "SUCCESS"
    | "FAILURE"
    | "NOT_RECORDED"
    | null;

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

export interface EvidenceLedgerRecord
  extends EvidenceLedgerInput {
  id: string;
  timestamp: string;
  version: 1;

  email: string;
  domain: string | null;
}

/*
==================================================
NORMALIZATION
==================================================
*/

function normalizeEmail(
  email: string
): string {
  return email
    .trim()
    .toLowerCase();
}

function normalizeDomain(
  domain?: string | null
): string | null {
  if (!domain) {
    return null;
  }

  const normalized = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    ?.trim() ?? "";

  return normalized || null;
}

function extractDomain(
  email: string
): string | null {
  const atIndex = email.lastIndexOf("@");

  if (
    atIndex <= 0 ||
    atIndex >= email.length - 1
  ) {
    return null;
  }

  return (
    email
      .slice(atIndex + 1)
      .trim()
      .toLowerCase() || null
  );
}

/*
==================================================
VALIDATION
==================================================
*/

function validateEvidenceInput(
  input: EvidenceLedgerInput
): void {
  if (
    !input ||
    typeof input !== "object"
  ) {
    throw new Error(
      "Evidence ledger input is required"
    );
  }

  if (
    typeof input.email !== "string" ||
    !input.email.trim()
  ) {
    throw new Error(
      "email is required"
    );
  }

  if (
    !input.email.includes("@")
  ) {
    throw new Error(
      "email must contain @"
    );
  }

  if (
    typeof input.source !== "string" ||
    !input.source.trim()
  ) {
    throw new Error(
      "source is required"
    );
  }

  if (
    typeof input.outcome !== "string" ||
    !input.outcome.trim()
  ) {
    throw new Error(
      "outcome is required"
    );
  }
}

/*
==================================================
APPEND
==================================================
*/

/**
 * Primary public API.
 *
 * Records one immutable evidence event.
 */
export async function appendEvidence(
  input: EvidenceLedgerInput
): Promise<EvidenceLedgerRecord> {

  validateEvidenceInput(input);

  const email = normalizeEmail(input.email);
  const domain = normalizeDomain(input.domain) ?? extractDomain(email);

  const record: EvidenceLedgerRecord = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    version: 1,

    email,
    domain,

    source: input.source,
    outcome: input.outcome,

    responseCode: input.responseCode ?? null,
    responseMessage: input.responseMessage ?? null,
    smtpValid: input.smtpValid ?? null,
    mailboxExists: input.mailboxExists ?? null,
    catchAll: input.catchAll ?? null,
    retryRequired: input.retryRequired ?? null,
    retryReason: input.retryReason ?? null,
    mxAvailable: input.mxAvailable ?? null,
    mxHosts: input.mxHosts ?? [],
    primaryMX: input.primaryMX ?? null,
    provider: input.provider ?? null,
    pattern: input.pattern ?? null,
    patternEvidenceRecorded: input.patternEvidenceRecorded ?? null,
    patternEvidenceOutcome: input.patternEvidenceOutcome ?? null,
    patternAttempts: input.patternAttempts ?? null,
    patternSuccesses: input.patternSuccesses ?? null,
    patternFailures: input.patternFailures ?? null,
    verificationId: input.verificationId ?? null,
    requestId: input.requestId ?? null,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
    metadata: input.metadata ?? {},
    rawEvidence: input.rawEvidence ?? null,
  };

  const db = getDatabase();

  await db.query(
    `
    INSERT INTO evidence_ledger (
      id, email, domain, source, outcome,
      response_code, response_message,
      smtp_valid, mailbox_exists, catch_all, retry_required, retry_reason,
      mx_available, mx_hosts, primary_mx, provider,
      pattern, pattern_evidence_recorded, pattern_evidence_outcome,
      pattern_attempts, pattern_successes, pattern_failures,
      verification_id, request_id,
      error_code, error_message,
      metadata, raw_evidence, created_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7,
      $8, $9, $10, $11, $12,
      $13, $14, $15, $16,
      $17, $18, $19,
      $20, $21, $22,
      $23, $24,
      $25, $26,
      $27, $28, $29
    )
    `,
    [
      record.id, record.email, record.domain, record.source, record.outcome,
      record.responseCode, record.responseMessage,
      record.smtpValid, record.mailboxExists, record.catchAll, record.retryRequired, record.retryReason,
      record.mxAvailable, JSON.stringify(record.mxHosts ?? []), record.primaryMX, record.provider,
      record.pattern, record.patternEvidenceRecorded, record.patternEvidenceOutcome,
      record.patternAttempts, record.patternSuccesses, record.patternFailures,
      record.verificationId, record.requestId,
      record.errorCode, record.errorMessage,
      JSON.stringify(record.metadata ?? {}), record.rawEvidence ? JSON.stringify(record.rawEvidence) : null, record.timestamp,
    ]
  );

  return record;
}

/*
==================================================
BACKWARD COMPATIBILITY
==================================================
*/

/**
 * Existing orchestrator uses recordEvidence().
 *
 * Keep this alias permanently so existing code
 * continues to work.
 */
export async function recordEvidence(
  input: EvidenceLedgerInput
): Promise<EvidenceLedgerRecord> {
  return appendEvidence(input);
}

/*
==================================================
ROW MAPPING
==================================================
*/

interface EvidenceLedgerRow {
  id: string;
  email: string;
  domain: string | null;
  source: EvidenceSource;
  outcome: EvidenceOutcome;
  response_code: number | null;
  response_message: string | null;
  smtp_valid: boolean | null;
  mailbox_exists: boolean | null;
  catch_all: boolean | null;
  retry_required: boolean | null;
  retry_reason: string | null;
  mx_available: boolean | null;
  mx_hosts: unknown;
  primary_mx: string | null;
  provider: string | null;
  pattern: string | null;
  pattern_evidence_recorded: boolean | null;
  pattern_evidence_outcome: "SUCCESS" | "FAILURE" | "NOT_RECORDED" | null;
  pattern_attempts: number | null;
  pattern_successes: number | null;
  pattern_failures: number | null;
  verification_id: string | null;
  request_id: string | null;
  error_code: string | null;
  error_message: string | null;
  metadata: unknown;
  raw_evidence: unknown;
  created_at: string | Date;
}

function mapRow(row: EvidenceLedgerRow): EvidenceLedgerRecord {
  return {
    id: row.id,
    timestamp:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
    version: 1,

    email: row.email,
    domain: row.domain,

    source: row.source,
    outcome: row.outcome,

    responseCode: row.response_code,
    responseMessage: row.response_message,
    smtpValid: row.smtp_valid,
    mailboxExists: row.mailbox_exists,
    catchAll: row.catch_all,
    retryRequired: row.retry_required,
    retryReason: row.retry_reason,
    mxAvailable: row.mx_available,
    mxHosts: (row.mx_hosts as string[] | null) ?? [],
    primaryMX: row.primary_mx,
    provider: row.provider,
    pattern: row.pattern,
    patternEvidenceRecorded: row.pattern_evidence_recorded,
    patternEvidenceOutcome: row.pattern_evidence_outcome,
    patternAttempts: row.pattern_attempts,
    patternSuccesses: row.pattern_successes,
    patternFailures: row.pattern_failures,
    verificationId: row.verification_id,
    requestId: row.request_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    rawEvidence: row.raw_evidence ?? null,
  };
}

/*
==================================================
QUERIES
==================================================
*/

export async function getEvidenceByEmail(
  email: string
): Promise<EvidenceLedgerRecord[]> {

  const db = getDatabase();

  const result = await db.query<EvidenceLedgerRow>(
    `SELECT * FROM evidence_ledger WHERE email = $1 ORDER BY created_at ASC`,
    [normalizeEmail(email)]
  );

  return result.rows.map(mapRow);
}

export async function getEvidenceByVerificationId(
  verificationId: string
): Promise<EvidenceLedgerRecord[]> {

  const normalized = verificationId.trim();

  if (!normalized) {
    return [];
  }

  const db = getDatabase();

  const result = await db.query<EvidenceLedgerRow>(
    `SELECT * FROM evidence_ledger WHERE verification_id = $1 ORDER BY created_at ASC`,
    [normalized]
  );

  return result.rows.map(mapRow);
}

export async function getEvidenceByDomain(
  domain: string
): Promise<EvidenceLedgerRecord[]> {

  const normalized = normalizeDomain(domain);

  if (!normalized) {
    return [];
  }

  const db = getDatabase();

  const result = await db.query<EvidenceLedgerRow>(
    `SELECT * FROM evidence_ledger WHERE domain = $1 ORDER BY created_at ASC`,
    [normalized]
  );

  return result.rows.map(mapRow);
}

export async function getEvidenceCount(): Promise<number> {

  const db = getDatabase();

  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM evidence_ledger`
  );

  return Number(result.rows[0]?.count ?? 0);
}

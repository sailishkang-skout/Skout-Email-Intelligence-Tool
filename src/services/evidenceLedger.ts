import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile
} from "node:fs/promises";
import path from "node:path";

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

Storage:

JSONL
data/evidence-ledger.jsonl

One observation per line.
==================================================
*/

const STORAGE_DIR = path.resolve(
  process.env.EVIDENCE_LEDGER_DIR ?? "./data"
);

const STORAGE_FILE = path.join(
  STORAGE_DIR,
  "evidence-ledger.jsonl"
);

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

function nullableBoolean(
  value?: boolean | null
): boolean | null {
  return value === undefined
    ? null
    : value;
}

function nullableNumber(
  value?: number | null
): number | null {
  if (
    value === undefined ||
    value === null
  ) {
    return null;
  }

  return Number.isFinite(value)
    ? value
    : null;
}

function nullableString(
  value?: string | null
): string | null {
  if (
    value === undefined ||
    value === null
  ) {
    return null;
  }

  const normalized = value.trim();

  return normalized || null;
}

function normalizeStringArray(
  value?: string[]
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (item): item is string =>
        typeof item === "string"
    )
    .map(
      item => item.trim()
    )
    .filter(Boolean);
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
RECORD BUILDER
==================================================
*/

function buildRecord(
  input: EvidenceLedgerInput
): EvidenceLedgerRecord {
  validateEvidenceInput(input);

  const email =
    normalizeEmail(input.email);

  const domain =
    normalizeDomain(input.domain) ??
    extractDomain(email);

  return {
    id:
      randomUUID(),

    timestamp:
      new Date().toISOString(),

    version:
      1,

    email,

    domain,

    source:
      input.source,

    outcome:
      input.outcome,

    responseCode:
      nullableNumber(
        input.responseCode
      ),

    responseMessage:
      nullableString(
        input.responseMessage
      ),

    smtpValid:
      nullableBoolean(
        input.smtpValid
      ),

    mailboxExists:
      nullableBoolean(
        input.mailboxExists
      ),

    catchAll:
      nullableBoolean(
        input.catchAll
      ),

    retryRequired:
      nullableBoolean(
        input.retryRequired
      ),

    retryReason:
      nullableString(
        input.retryReason
      ),

    mxAvailable:
      nullableBoolean(
        input.mxAvailable
      ),

    mxHosts:
      normalizeStringArray(
        input.mxHosts
      ),

    primaryMX:
      nullableString(
        input.primaryMX
      ),

    provider:
      nullableString(
        input.provider
      ),

    pattern:
      nullableString(
        input.pattern
      ),

    patternEvidenceRecorded:
      nullableBoolean(
        input.patternEvidenceRecorded
      ),

    patternEvidenceOutcome:
      input.patternEvidenceOutcome ??
      null,

    patternAttempts:
      nullableNumber(
        input.patternAttempts
      ),

    patternSuccesses:
      nullableNumber(
        input.patternSuccesses
      ),

    patternFailures:
      nullableNumber(
        input.patternFailures
      ),

    verificationId:
      nullableString(
        input.verificationId
      ),

    requestId:
      nullableString(
        input.requestId
      ),

    errorCode:
      nullableString(
        input.errorCode
      ),

    errorMessage:
      nullableString(
        input.errorMessage
      ),

    metadata:
      input.metadata ?? {},

    rawEvidence:
      input.rawEvidence ?? null
  };
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
  const record =
    buildRecord(input);

  await mkdir(
    STORAGE_DIR,
    {
      recursive: true
    }
  );

  await appendFile(
    STORAGE_FILE,
    `${JSON.stringify(record)}\n`,
    "utf8"
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
READ ALL
==================================================
*/

export async function readEvidenceLedger(): Promise<
  EvidenceLedgerRecord[]
> {
  try {
    const contents =
      await readFile(
        STORAGE_FILE,
        "utf8"
      );

    const lines =
      contents
        .split("\n")
        .map(
          line => line.trim()
        )
        .filter(Boolean);

    const records: EvidenceLedgerRecord[] = [];

    for (const line of lines) {
      try {
        const parsed =
          JSON.parse(line);

        if (
          parsed &&
          typeof parsed === "object"
        ) {
          records.push(
            parsed as EvidenceLedgerRecord
          );
        }
      } catch {
        /*
         * Ignore malformed historical lines.
         *
         * We don't want one corrupt audit record
         * to make the entire ledger unreadable.
         */
      }
    }

    return records;
  } catch (error) {
    const code =
      error &&
      typeof error === "object" &&
      "code" in error
        ? error.code
        : null;

    if (code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

/*
==================================================
QUERY BY EMAIL
==================================================
*/

export async function getEvidenceByEmail(
  email: string
): Promise<EvidenceLedgerRecord[]> {
  const normalized =
    normalizeEmail(email);

  const records =
    await readEvidenceLedger();

  return records.filter(
    record =>
      normalizeEmail(
        record.email
      ) === normalized
  );
}

/*
==================================================
QUERY BY VERIFICATION ID
==================================================
*/

export async function getEvidenceByVerificationId(
  verificationId: string
): Promise<EvidenceLedgerRecord[]> {
  const normalized =
    verificationId.trim();

  if (!normalized) {
    return [];
  }

  const records =
    await readEvidenceLedger();

  return records.filter(
    record =>
      record.verificationId ===
      normalized
  );
}

/*
==================================================
QUERY BY DOMAIN
==================================================
*/

export async function getEvidenceByDomain(
  domain: string
): Promise<EvidenceLedgerRecord[]> {
  const normalized =
    normalizeDomain(domain);

  if (!normalized) {
    return [];
  }

  const records =
    await readEvidenceLedger();

  return records.filter(
    record =>
      record.domain ===
      normalized
  );
}

/*
==================================================
COUNT
==================================================
*/

export async function getEvidenceCount(): Promise<number> {
  const records =
    await readEvidenceLedger();

  return records.length;
}

/*
==================================================
STORAGE INFO
==================================================
*/

export function getEvidenceLedgerStoragePath(): string {
  return STORAGE_FILE;
}
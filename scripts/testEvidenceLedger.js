import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
/*
==================================================
EVIDENCE LEDGER
==================================================

Purpose:

Store what actually happened during verification.

IMPORTANT ARCHITECTURAL RULE:

Evidence Ledger
    =
    FACTS / OBSERVATIONS

Confidence Engine
    =
    TRUST / SCORING

Recommendation Engine
    =
    ACTION

The Evidence Ledger must NOT:

- calculate confidence
- rank candidates
- recommend sending
- decide whether an email is valid
- mutate pattern intelligence

It only records observations.

==================================================
STORAGE
==================================================

Initial implementation:

JSONL file

One verification event per line.

This gives us:

- append-only behavior
- easy debugging
- easy export
- easy migration to PostgreSQL later
- no additional dependency

Production database migration can happen later.
==================================================
*/
const DEFAULT_STORAGE_DIR = path.resolve(process.env.EVIDENCE_LEDGER_DIR ??
    "./data");
const DEFAULT_STORAGE_FILE = path.join(DEFAULT_STORAGE_DIR, "evidence-ledger.jsonl");
/*
==================================================
NORMALIZATION
==================================================
*/
function normalizeEmail(email) {
    return email
        .trim()
        .toLowerCase();
}
function normalizeDomain(domain) {
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
function extractDomain(email) {
    const atIndex = email.lastIndexOf("@");
    if (atIndex <= 0 ||
        atIndex >= email.length - 1) {
        return null;
    }
    return (email
        .slice(atIndex + 1)
        .trim()
        .toLowerCase() ||
        null);
}
/*
==================================================
SANITIZE
==================================================

Do not allow undefined values to make the
audit record inconsistent.

==================================================
*/
function nullableBoolean(value) {
    return value === undefined
        ? null
        : value;
}
function nullableNumber(value) {
    return value === undefined
        ? null
        : value;
}
function nullableString(value) {
    if (value === undefined ||
        value === null) {
        return null;
    }
    const normalized = value.trim();
    return normalized || null;
}
/*
==================================================
CREATE RECORD
==================================================
*/
function createRecord(input) {
    const email = normalizeEmail(input.email);
    const explicitDomain = normalizeDomain(input.domain);
    const domain = explicitDomain ??
        extractDomain(email);
    return {
        id: input.verificationId?.trim() ||
            randomUUID(),
        timestamp: new Date().toISOString(),
        version: 1,
        email,
        domain,
        source: input.source,
        outcome: input.outcome,
        responseCode: nullableNumber(input.responseCode),
        responseMessage: nullableString(input.responseMessage),
        smtpValid: nullableBoolean(input.smtpValid),
        mailboxExists: nullableBoolean(input.mailboxExists),
        catchAll: nullableBoolean(input.catchAll),
        retryRequired: nullableBoolean(input.retryRequired),
        retryReason: nullableString(input.retryReason),
        mxAvailable: nullableBoolean(input.mxAvailable),
        mxHosts: Array.isArray(input.mxHosts)
            ? [
                ...input.mxHosts
            ]
            : [],
        primaryMX: nullableString(input.primaryMX),
        provider: nullableString(input.provider),
        pattern: nullableString(input.pattern),
        patternEvidenceRecorded: nullableBoolean(input.patternEvidenceRecorded),
        patternEvidenceOutcome: input.patternEvidenceOutcome ??
            null,
        patternAttempts: nullableNumber(input.patternAttempts),
        patternSuccesses: nullableNumber(input.patternSuccesses),
        patternFailures: nullableNumber(input.patternFailures),
        verificationId: nullableString(input.verificationId),
        requestId: nullableString(input.requestId),
        errorCode: nullableString(input.errorCode),
        errorMessage: nullableString(input.errorMessage),
        metadata: input.metadata
            ? {
                ...input.metadata
            }
            : {},
        rawEvidence: input.rawEvidence ??
            null
    };
}
/*
==================================================
WRITE
==================================================
*/
export async function recordEvidence(input) {
    if (!input ||
        typeof input.email !== "string" ||
        !input.email.trim()) {
        throw new Error("Evidence email is required");
    }
    if (!input.source) {
        throw new Error("Evidence source is required");
    }
    if (!input.outcome) {
        throw new Error("Evidence outcome is required");
    }
    const record = createRecord(input);
    await mkdir(DEFAULT_STORAGE_DIR, {
        recursive: true
    });
    await appendFile(DEFAULT_STORAGE_FILE, `${JSON.stringify(record)}\n`, "utf8");
    return record;
}
/*
==================================================
READ ALL
==================================================
*/
export async function getEvidenceRecords(options) {
    let contents;
    try {
        contents =
            await readFile(DEFAULT_STORAGE_FILE, "utf8");
    }
    catch (error) {
        const code = typeof error === "object" &&
            error !== null &&
            "code" in error
            ? error.code
            : null;
        if (code === "ENOENT") {
            return [];
        }
        throw error;
    }
    const lines = contents
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean);
    const records = [];
    for (const line of lines) {
        try {
            const record = JSON.parse(line);
            records.push(record);
        }
        catch {
            /*
            Never let one corrupt audit row
            destroy the entire ledger read.
            */
            continue;
        }
    }
    let filtered = records;
    if (options?.email) {
        const email = normalizeEmail(options.email);
        filtered =
            filtered.filter(record => record.email ===
                email);
    }
    if (options?.domain) {
        const domain = normalizeDomain(options.domain);
        filtered =
            filtered.filter(record => record.domain ===
                domain);
    }
    if (options?.source) {
        filtered =
            filtered.filter(record => record.source ===
                options.source);
    }
    /*
    Most recent first.
    */
    filtered =
        filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    if (options?.limit !== undefined) {
        const limit = Math.max(0, Math.floor(options.limit));
        filtered =
            filtered.slice(0, limit);
    }
    return filtered;
}
/*
==================================================
GET EMAIL HISTORY
==================================================
*/
export async function getEmailEvidenceHistory(email, limit = 100) {
    return getEvidenceRecords({
        email,
        limit
    });
}
/*
==================================================
GET DOMAIN HISTORY
==================================================
*/
export async function getDomainEvidenceHistory(domain, limit = 100) {
    return getEvidenceRecords({
        domain,
        limit
    });
}
/*
==================================================
GET LATEST EVIDENCE
==================================================
*/
export async function getLatestEvidence(email) {
    const records = await getEvidenceRecords({
        email,
        limit: 1
    });
    return (records[0] ??
        null);
}
/*
==================================================
COUNT
==================================================
*/
export async function countEvidence(email) {
    const records = await getEvidenceRecords(email
        ? {
            email
        }
        : undefined);
    return records.length;
}
//# sourceMappingURL=testEvidenceLedger.js.map
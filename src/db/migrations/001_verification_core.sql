-- Core verification persistence: the latest verification result per
-- attempt, its timeline of stage events, raw evidence, and the final
-- decision ledger. This is a consolidated, final-state schema (the
-- SQLite predecessor evolved through several incremental ALTER TABLE
-- migrations; since there is no existing Postgres data to preserve
-- compatibility with, this collapses that history into one clean
-- definition rather than replaying it step by step).

CREATE TABLE IF NOT EXISTS verification_results (
    id UUID PRIMARY KEY,
    verification_id UUID NOT NULL UNIQUE,
    request_id TEXT,

    email TEXT NOT NULL,
    domain TEXT NOT NULL,
    pattern TEXT,
    provider TEXT,

    response_code INTEGER,
    response_message TEXT,

    smtp_valid BOOLEAN,
    mailbox_exists BOOLEAN,
    mx_available BOOLEAN,
    catch_all BOOLEAN,
    retry_required BOOLEAN,
    retry_reason TEXT,

    confidence_score REAL,
    confidence_level TEXT,
    decision TEXT,
    recommendation TEXT,
    verification_status TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_verification_results_email
    ON verification_results (email);

CREATE INDEX IF NOT EXISTS idx_verification_results_domain
    ON verification_results (domain);

CREATE INDEX IF NOT EXISTS idx_verification_results_created_at
    ON verification_results (created_at);

CREATE INDEX IF NOT EXISTS idx_verification_results_status
    ON verification_results (verification_status);

CREATE INDEX IF NOT EXISTS idx_verification_results_decision
    ON verification_results (decision);


CREATE TABLE IF NOT EXISTS verification_events (
    id UUID PRIMARY KEY,
    verification_id UUID NOT NULL,

    stage TEXT NOT NULL
        CHECK (stage IN (
            'VERIFICATION', 'MX', 'SMTP', 'CATCH_ALL',
            'EVIDENCE', 'DECISION', 'PATTERN'
        )),

    status TEXT NOT NULL
        CHECK (status IN ('STARTED', 'COMPLETED', 'FAILED')),

    metadata JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_verification_events_verification_id
    ON verification_events (verification_id);


CREATE TABLE IF NOT EXISTS verification_evidence (
    id UUID PRIMARY KEY,
    verification_id UUID NOT NULL
        REFERENCES verification_results (verification_id)
        ON DELETE CASCADE,

    evidence_type TEXT NOT NULL,
    source TEXT NOT NULL,
    signal TEXT NOT NULL,
    value TEXT,
    confidence_score REAL,
    metadata JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_verification_evidence_verification_id
    ON verification_evidence (verification_id);

CREATE INDEX IF NOT EXISTS idx_verification_evidence_type
    ON verification_evidence (evidence_type);

CREATE INDEX IF NOT EXISTS idx_verification_evidence_created_at
    ON verification_evidence (created_at);


CREATE TABLE IF NOT EXISTS verification_decisions (
    id UUID PRIMARY KEY,
    verification_id UUID NOT NULL UNIQUE
        REFERENCES verification_results (verification_id)
        ON DELETE CASCADE,

    email TEXT NOT NULL,
    decision TEXT NOT NULL,
    verification_status TEXT NOT NULL,
    confidence_score REAL NOT NULL,
    confidence_level TEXT NOT NULL,

    reason_codes JSONB NOT NULL,
    evidence_snapshot JSONB NOT NULL,
    engine_version TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_verification_decisions_email
    ON verification_decisions (email);

CREATE INDEX IF NOT EXISTS idx_verification_decisions_status
    ON verification_decisions (verification_status);

CREATE INDEX IF NOT EXISTS idx_verification_decisions_created
    ON verification_decisions (created_at);

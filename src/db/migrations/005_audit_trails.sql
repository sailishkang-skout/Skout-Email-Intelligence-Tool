-- Append-only audit trails that previously wrote to local JSONL
-- files (data/evidence-ledger.jsonl, data/verification-attempt-history.jsonl).
-- That works on a developer's laptop but not in a container: the
-- data is invisible to other replicas and lost on every restart/
-- redeploy. PostgreSQL is this service's durable store, so these
-- belong here too.

CREATE TABLE IF NOT EXISTS evidence_ledger (
    id UUID PRIMARY KEY,

    email TEXT NOT NULL,
    domain TEXT,

    source TEXT NOT NULL,
    outcome TEXT NOT NULL,

    response_code INTEGER,
    response_message TEXT,

    smtp_valid BOOLEAN,
    mailbox_exists BOOLEAN,
    catch_all BOOLEAN,
    retry_required BOOLEAN,
    retry_reason TEXT,

    mx_available BOOLEAN,
    mx_hosts JSONB,
    primary_mx TEXT,
    provider TEXT,

    pattern TEXT,
    pattern_evidence_recorded BOOLEAN,
    pattern_evidence_outcome TEXT,
    pattern_attempts INTEGER,
    pattern_successes INTEGER,
    pattern_failures INTEGER,

    verification_id UUID,
    request_id TEXT,

    error_code TEXT,
    error_message TEXT,

    metadata JSONB,
    raw_evidence JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evidence_ledger_email
    ON evidence_ledger (email);

CREATE INDEX IF NOT EXISTS idx_evidence_ledger_domain
    ON evidence_ledger (domain);

CREATE INDEX IF NOT EXISTS idx_evidence_ledger_verification_id
    ON evidence_ledger (verification_id);

CREATE INDEX IF NOT EXISTS idx_evidence_ledger_created_at
    ON evidence_ledger (created_at);


CREATE TABLE IF NOT EXISTS verification_attempt_history (
    id UUID PRIMARY KEY,

    email TEXT NOT NULL,
    domain TEXT,

    method TEXT NOT NULL,
    outcome TEXT NOT NULL,
    success BOOLEAN NOT NULL,

    response_code INTEGER,
    response_message TEXT,

    mailbox_exists BOOLEAN,
    smtp_valid BOOLEAN,
    catch_all BOOLEAN,
    retry_required BOOLEAN,
    retry_reason TEXT,

    mx_available BOOLEAN,
    mx_hosts JSONB,
    primary_mx TEXT,
    provider TEXT,
    pattern TEXT,

    verification_id UUID,
    request_id TEXT,

    cache_hit BOOLEAN,
    cache_age_ms INTEGER,

    error_code TEXT,
    error_message TEXT,

    metadata JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_verification_attempt_history_email
    ON verification_attempt_history (email);

CREATE INDEX IF NOT EXISTS idx_verification_attempt_history_domain
    ON verification_attempt_history (domain);

CREATE INDEX IF NOT EXISTS idx_verification_attempt_history_verification_id
    ON verification_attempt_history (verification_id);

CREATE INDEX IF NOT EXISTS idx_verification_attempt_history_created_at
    ON verification_attempt_history (created_at);

-- Durable batch verification job queue: one job per batch request,
-- one item per email. Workers claim items via a leased ownership
-- model (worker_id + lease_expires_at) with bounded retries and
-- exponential backoff (next_attempt_at). Consolidated final shape
-- (the SQLite predecessor added worker leases and retry columns via
-- separate incremental ALTER TABLE migrations).

CREATE TABLE IF NOT EXISTS verification_jobs (
    id UUID PRIMARY KEY,

    status TEXT NOT NULL
        CHECK (status IN (
            'PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'
        )),

    total_emails INTEGER NOT NULL DEFAULT 0,
    processed_emails INTEGER NOT NULL DEFAULT 0,
    successful INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_verification_jobs_status
    ON verification_jobs (status);


CREATE TABLE IF NOT EXISTS verification_job_items (
    id UUID PRIMARY KEY,
    job_id UUID NOT NULL
        REFERENCES verification_jobs (id)
        ON DELETE CASCADE,

    email TEXT NOT NULL,

    status TEXT NOT NULL
        CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),

    result_json JSONB,

    -- Worker lease (ownership while PROCESSING).
    worker_id UUID,
    processing_started_at TIMESTAMPTZ,
    lease_expires_at TIMESTAMPTZ,
    attempt_count INTEGER NOT NULL DEFAULT 0,

    -- Retry / backoff.
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    next_attempt_at TIMESTAMPTZ,
    last_retry_at TIMESTAMPTZ,
    last_error TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_verification_job_items_job
    ON verification_job_items (job_id);

CREATE INDEX IF NOT EXISTS idx_verification_job_items_status
    ON verification_job_items (status);

CREATE INDEX IF NOT EXISTS idx_verification_job_items_lease
    ON verification_job_items (status, lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_verification_job_items_worker
    ON verification_job_items (worker_id);

CREATE INDEX IF NOT EXISTS idx_verification_job_items_retry
    ON verification_job_items (status, next_attempt_at);

-- Claiming (SELECT ... FOR UPDATE SKIP LOCKED) filters heavily on
-- job_id + status + retry_count + next_attempt_at together; a
-- composite index matches that access pattern directly instead of
-- relying on the planner to combine several single-column indexes.
CREATE INDEX IF NOT EXISTS idx_verification_job_items_claimable
    ON verification_job_items (job_id, status, retry_count, next_attempt_at);

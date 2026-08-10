-- Transactional outbox for the async batch verification pipeline.
-- Written in the SAME Postgres transaction as verification_jobs and
-- verification_job_items (see createVerificationJob), so a job can
-- never exist without a corresponding outbox row to drive its BullMQ
-- enqueue - and vice versa, FK constraints make an orphaned outbox
-- row structurally impossible. A separate dispatcher process claims
-- PENDING rows (FOR UPDATE SKIP LOCKED) and enqueues them into
-- BullMQ, decoupling "durably accepted" (this table) from "queued
-- for execution" (Redis/BullMQ), which may be temporarily unavailable.

CREATE TABLE IF NOT EXISTS verification_outbox (
    id UUID PRIMARY KEY,
    job_id UUID NOT NULL REFERENCES verification_jobs(id) ON DELETE CASCADE,
    item_id UUID NOT NULL REFERENCES verification_job_items(id) ON DELETE CASCADE,
    email TEXT NOT NULL,

    status TEXT NOT NULL CHECK (
        status IN ('PENDING', 'DISPATCHED', 'FAILED')
    ),

    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    dispatched_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_verification_outbox_pending
    ON verification_outbox (status, next_attempt_at);

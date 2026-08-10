-- The dispatcher's claim query (claimPendingOutboxRows in
-- verificationJobService.ts) is:
--
--   WHERE status = 'PENDING' AND next_attempt_at <= NOW()
--   ORDER BY created_at ASC
--
-- The original idx_verification_outbox_pending (status,
-- next_attempt_at) supports the equality+range filter but not the
-- ORDER BY, forcing an extra sort step on every dispatcher poll once
-- the backlog is non-trivial. Leading with (status, created_at)
-- instead lets Postgres satisfy the equality filter AND return rows
-- already in created_at order directly from the index - next_attempt_at
-- <= NOW() becomes a cheap per-row filter applied during that same
-- scan, rather than requiring a separate sort of the filtered set.

DROP INDEX IF EXISTS idx_verification_outbox_pending;

CREATE INDEX IF NOT EXISTS idx_verification_outbox_claim
    ON verification_outbox (status, created_at);

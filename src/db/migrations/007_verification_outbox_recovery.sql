-- Tracks explicit dead-letter recovery of verification_outbox rows
-- (see recoverFailedOutboxRows() in verificationJobService.ts). A row
-- that exhausts MAX_OUTBOX_ATTEMPTS flips to the terminal FAILED
-- status and is never automatically retried again - recovery resets
-- it back to PENDING with a fresh attempt budget, but that history
-- must stay visible rather than being silently erased by the reset:
-- recovery_count distinguishes "needed manual recovery N times" from
-- the raw attempts counter (which recovery intentionally resets to 0
-- to give the row a genuine fresh retry budget).

ALTER TABLE verification_outbox
    ADD COLUMN IF NOT EXISTS recovery_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE verification_outbox
    ADD COLUMN IF NOT EXISTS last_recovered_at TIMESTAMPTZ;

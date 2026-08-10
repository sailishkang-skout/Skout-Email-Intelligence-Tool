-- Guarantees one verification_job_item <-> one verification_outbox
-- row at the database level. Today this 1:1 relationship is only
-- enforced by application code (a single insert site, inside
-- createVerificationJob's transaction) - correct in practice, but a
-- future code change that accidentally inserted a second outbox row
-- for the same item would previously only be caught downstream by
-- BullMQ's jobId dedup (masking the real bug rather than surfacing
-- it). This constraint makes the invariant structural instead.

ALTER TABLE verification_outbox
    ADD CONSTRAINT uq_verification_outbox_item_id UNIQUE (item_id);

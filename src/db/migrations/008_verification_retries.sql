ALTER TABLE verification_job_items
ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 3;

ALTER TABLE verification_job_items
ADD COLUMN next_attempt_at DATETIME;

ALTER TABLE verification_job_items
ADD COLUMN last_retry_at DATETIME;

ALTER TABLE verification_job_items
ADD COLUMN last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_verification_job_items_retry
ON verification_job_items(status, next_attempt_at);

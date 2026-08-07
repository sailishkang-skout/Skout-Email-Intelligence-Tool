ALTER TABLE verification_job_items
ADD COLUMN worker_id TEXT;

ALTER TABLE verification_job_items
ADD COLUMN processing_started_at DATETIME;

ALTER TABLE verification_job_items
ADD COLUMN lease_expires_at DATETIME;

ALTER TABLE verification_job_items
ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_verification_job_items_lease
ON verification_job_items(status, lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_verification_job_items_worker
ON verification_job_items(worker_id);

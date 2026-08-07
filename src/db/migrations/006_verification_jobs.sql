/*
==================================================
VERIFICATION JOB QUEUE
==================================================
*/


CREATE TABLE IF NOT EXISTS verification_jobs (

    id TEXT PRIMARY KEY,

    status TEXT NOT NULL
        CHECK(
            status IN (
                'PENDING',
                'RUNNING',
                'COMPLETED',
                'FAILED',
                'CANCELLED'
            )
        ),

    total_emails INTEGER NOT NULL DEFAULT 0,

    processed_emails INTEGER NOT NULL DEFAULT 0,

    successful INTEGER NOT NULL DEFAULT 0,

    failed INTEGER NOT NULL DEFAULT 0,


    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    started_at DATETIME,

    completed_at DATETIME

);



/*
==================================================
JOB ITEMS
==================================================
*/


CREATE TABLE IF NOT EXISTS verification_job_items (

    id TEXT PRIMARY KEY,


    job_id TEXT NOT NULL,


    email TEXT NOT NULL,


    status TEXT NOT NULL
        CHECK(
            status IN(
                'PENDING',
                'PROCESSING',
                'COMPLETED',
                'FAILED'
            )
        ),


    retry_count INTEGER NOT NULL DEFAULT 0,


    result_json TEXT,


    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,


    completed_at DATETIME,


    FOREIGN KEY(job_id)
        REFERENCES verification_jobs(id)
        ON DELETE CASCADE

);



CREATE INDEX IF NOT EXISTS idx_verification_jobs_status
ON verification_jobs(status);



CREATE INDEX IF NOT EXISTS idx_verification_job_items_job
ON verification_job_items(job_id);



CREATE INDEX IF NOT EXISTS idx_verification_job_items_status
ON verification_job_items(status);

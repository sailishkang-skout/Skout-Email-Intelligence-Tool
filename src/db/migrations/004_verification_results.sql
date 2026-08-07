/*
==================================================
004_verification_results.sql
==================================================

Stores the latest verification state for every
email address.

One row per verification result.

==================================================
*/

CREATE TABLE IF NOT EXISTS verification_results (

    id TEXT PRIMARY KEY,

    verification_id TEXT NOT NULL UNIQUE,

    request_id TEXT,

    email TEXT NOT NULL,

    domain TEXT NOT NULL,

    pattern TEXT,

    provider TEXT,

    response_code INTEGER,

    response_message TEXT,

    smtp_valid INTEGER,

    mailbox_exists INTEGER,

    mx_available INTEGER,

    catch_all INTEGER,

    retry_required INTEGER,

    retry_reason TEXT,

    confidence_score REAL,

    confidence_level TEXT,

    decision TEXT,

    recommendation TEXT,

    verification_status TEXT,

    created_at TEXT NOT NULL,

    updated_at TEXT NOT NULL

);

CREATE INDEX IF NOT EXISTS idx_verification_results_email
ON verification_results(email);

CREATE INDEX IF NOT EXISTS idx_verification_results_domain
ON verification_results(domain);

CREATE INDEX IF NOT EXISTS idx_verification_results_verification_id
ON verification_results(verification_id);

CREATE INDEX IF NOT EXISTS idx_verification_results_created_at
ON verification_results(created_at);

CREATE INDEX IF NOT EXISTS idx_verification_results_status
ON verification_results(verification_status);

CREATE INDEX IF NOT EXISTS idx_verification_results_decision
ON verification_results(decision);

/*
009_verification_decisions.sql

Authoritative verification decision ledger.

Stores final decision output from:

Evidence System
        |
Confidence Engine
        |
Decision Engine

Used for:
- audit history
- send safety
- explainability
*/

CREATE TABLE IF NOT EXISTS verification_decisions (

    id TEXT PRIMARY KEY,

    verification_id TEXT NOT NULL UNIQUE,

    email TEXT NOT NULL,

    decision TEXT NOT NULL,

    verification_status TEXT NOT NULL,

    confidence_score REAL NOT NULL,

    confidence_level TEXT NOT NULL,

    reason_codes TEXT NOT NULL,

    evidence_snapshot TEXT NOT NULL,

    engine_version TEXT NOT NULL,

    created_at TEXT NOT NULL,


    FOREIGN KEY (
        verification_id
    )
    REFERENCES verification_results(
        verification_id
    )
    ON DELETE CASCADE

);


CREATE INDEX IF NOT EXISTS idx_verification_decisions_email
ON verification_decisions(email);


CREATE INDEX IF NOT EXISTS idx_verification_decisions_status
ON verification_decisions(verification_status);


CREATE INDEX IF NOT EXISTS idx_verification_decisions_created
ON verification_decisions(created_at);
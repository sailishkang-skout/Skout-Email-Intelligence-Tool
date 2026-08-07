CREATE TABLE verification_evidence (

    id TEXT PRIMARY KEY,

    verification_id TEXT NOT NULL,

    evidence_type TEXT NOT NULL,

    source TEXT NOT NULL,

    signal TEXT NOT NULL,

    value TEXT,

    confidence_score REAL,

    metadata TEXT,

    created_at TEXT NOT NULL,

    FOREIGN KEY (
        verification_id
    )
    REFERENCES verification_results(
        verification_id
    )
    ON DELETE CASCADE

);


CREATE INDEX idx_verification_evidence_verification_id
ON verification_evidence(
    verification_id
);


CREATE INDEX idx_verification_evidence_type
ON verification_evidence(
    evidence_type
);


CREATE INDEX idx_verification_evidence_created_at
ON verification_evidence(
    created_at
);

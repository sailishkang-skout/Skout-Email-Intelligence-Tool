-- Foundational tables for pattern intelligence.
--
-- These tables were previously created out-of-band (not through a
-- tracked migration), so fresh installs crashed on first use of
-- patternIntelligence.ts / patternHistory.ts / patternRanker.ts with
-- "no such table: pattern_history". This migration makes their
-- schema explicit and reproducible. CREATE TABLE IF NOT EXISTS keeps
-- this safe to apply against databases that already have these
-- tables from before this migration existed.

CREATE TABLE IF NOT EXISTS pattern_history (
    domain TEXT NOT NULL,
    pattern TEXT NOT NULL,

    attempts INTEGER NOT NULL DEFAULT 0,
    successes INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,

    confidence REAL NOT NULL DEFAULT 0,

    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,

    PRIMARY KEY (domain, pattern)
);

CREATE INDEX IF NOT EXISTS idx_pattern_history_domain
  ON pattern_history (
    domain
  );

CREATE TABLE IF NOT EXISTS pattern_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    domain TEXT NOT NULL,

    pattern TEXT NOT NULL,

    outcome TEXT NOT NULL
        CHECK (outcome IN ('SUCCESS', 'FAILURE')),

    source TEXT NOT NULL
        CHECK (
            source IN (
                'SMTP',
                'MANUAL',
                'IMPORTED',
                'OTHER'
            )
        ),

    response_code INTEGER,

    verification_id TEXT,

    observed_at TEXT NOT NULL,

    confidence_at_observation REAL NOT NULL,

    FOREIGN KEY (
        domain,
        pattern
    )
    REFERENCES pattern_history (
        domain,
        pattern
    )
);

CREATE INDEX IF NOT EXISTS idx_pattern_observations_domain_pattern
ON pattern_observations (
    domain,
    pattern
);

CREATE INDEX IF NOT EXISTS idx_pattern_observations_verification
ON pattern_observations (
    verification_id
);

CREATE INDEX IF NOT EXISTS idx_pattern_observations_observed_at
ON pattern_observations (
    observed_at
);

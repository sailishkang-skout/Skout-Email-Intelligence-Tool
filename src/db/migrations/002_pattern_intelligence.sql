-- Pattern history and observations, used by patternIntelligence.ts /
-- patternHistory.ts / patternRanker.ts to learn which email-address
-- patterns (first.last@, flast@, etc.) actually work for a domain.

CREATE TABLE IF NOT EXISTS pattern_history (
    domain TEXT NOT NULL,
    pattern TEXT NOT NULL,

    attempts INTEGER NOT NULL DEFAULT 0,
    successes INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,

    confidence REAL NOT NULL DEFAULT 0,

    first_seen_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL,

    PRIMARY KEY (domain, pattern)
);

CREATE INDEX IF NOT EXISTS idx_pattern_history_domain
    ON pattern_history (domain);


CREATE TABLE IF NOT EXISTS pattern_observations (
    id BIGSERIAL PRIMARY KEY,

    domain TEXT NOT NULL,
    pattern TEXT NOT NULL,

    outcome TEXT NOT NULL
        CHECK (outcome IN ('SUCCESS', 'FAILURE')),

    source TEXT NOT NULL
        CHECK (source IN ('SMTP', 'MANUAL', 'IMPORTED', 'OTHER')),

    response_code INTEGER,
    verification_id UUID,

    observed_at TIMESTAMPTZ NOT NULL,
    confidence_at_observation REAL NOT NULL,

    FOREIGN KEY (domain, pattern)
        REFERENCES pattern_history (domain, pattern)
);

CREATE INDEX IF NOT EXISTS idx_pattern_observations_domain_pattern
    ON pattern_observations (domain, pattern);

CREATE INDEX IF NOT EXISTS idx_pattern_observations_verification
    ON pattern_observations (verification_id);

CREATE INDEX IF NOT EXISTS idx_pattern_observations_observed_at
    ON pattern_observations (observed_at);

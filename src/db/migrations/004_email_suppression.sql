CREATE TABLE IF NOT EXISTS email_suppression (
    id BIGSERIAL PRIMARY KEY,

    email TEXT NOT NULL UNIQUE,

    suppressed BOOLEAN NOT NULL DEFAULT FALSE,
    suppression_type TEXT NOT NULL DEFAULT 'NONE',
    reason_code TEXT NOT NULL DEFAULT 'UNKNOWN',
    reason TEXT NOT NULL DEFAULT '',

    bounce_count INTEGER NOT NULL DEFAULT 0,
    hard_bounce_count INTEGER NOT NULL DEFAULT 0,
    soft_bounce_count INTEGER NOT NULL DEFAULT 0,
    complaint_count INTEGER NOT NULL DEFAULT 0,
    unsubscribe_count INTEGER NOT NULL DEFAULT 0,

    first_bounced_at TIMESTAMPTZ,
    last_bounced_at TIMESTAMPTZ,
    last_verified_at TIMESTAMPTZ,
    last_response_code INTEGER,
    last_response_message TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_suppression_email
    ON email_suppression (email);

CREATE INDEX IF NOT EXISTS idx_email_suppression_suppressed
    ON email_suppression (suppressed);

CREATE INDEX IF NOT EXISTS idx_email_suppression_type
    ON email_suppression (suppression_type);

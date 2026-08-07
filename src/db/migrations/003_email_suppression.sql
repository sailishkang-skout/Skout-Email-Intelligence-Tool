CREATE TABLE IF NOT EXISTS email_suppression (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  email TEXT NOT NULL UNIQUE,

  suppressed INTEGER NOT NULL DEFAULT 0,

  suppression_type TEXT NOT NULL DEFAULT 'NONE',

  reason_code TEXT NOT NULL DEFAULT 'UNKNOWN',

  reason TEXT NOT NULL DEFAULT '',

  bounce_count INTEGER NOT NULL DEFAULT 0,

  hard_bounce_count INTEGER NOT NULL DEFAULT 0,

  soft_bounce_count INTEGER NOT NULL DEFAULT 0,

  complaint_count INTEGER NOT NULL DEFAULT 0,

  unsubscribe_count INTEGER NOT NULL DEFAULT 0,

  first_bounced_at TEXT,

  last_bounced_at TEXT,

  last_verified_at TEXT,

  last_response_code INTEGER,

  last_response_message TEXT,

  created_at TEXT NOT NULL,

  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_suppression_email
ON email_suppression(email);

CREATE INDEX IF NOT EXISTS idx_email_suppression_suppressed
ON email_suppression(suppressed);

CREATE INDEX IF NOT EXISTS idx_email_suppression_type
ON email_suppression(suppression_type);

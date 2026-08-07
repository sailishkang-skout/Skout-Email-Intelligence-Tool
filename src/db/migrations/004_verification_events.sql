CREATE TABLE IF NOT EXISTS verification_events (

  id TEXT PRIMARY KEY,

  verification_id TEXT NOT NULL,

  stage TEXT NOT NULL,

  status TEXT NOT NULL,

  metadata TEXT,

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP

);


CREATE INDEX IF NOT EXISTS idx_verification_events_verification_id
ON verification_events(
  verification_id
);
-- One row per GitHub account. The token is never stored: only the numeric
-- id and login, so an upload replaces that account's last one.
CREATE TABLE IF NOT EXISTS scores (
  github_id INTEGER PRIMARY KEY,
  login TEXT NOT NULL,
  entry_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind INTEGER NOT NULL,
  mean INTEGER NOT NULL,
  prompts INTEGER NOT NULL,
  score REAL NOT NULL,
  uploaded_at INTEGER NOT NULL,
  upload_day TEXT NOT NULL,
  uploads_today INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS scores_by_score ON scores (score, uploaded_at);

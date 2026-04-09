CREATE TABLE IF NOT EXISTS agent_sessions (
  agent_name     TEXT NOT NULL,
  document_id    TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (agent_name, document_id)
);

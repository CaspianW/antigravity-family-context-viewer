CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT NOT NULL,
  note TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  device_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  app_version TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_events (
  event_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(device_id),
  member_id TEXT NOT NULL REFERENCES members(id),
  account_scope_key TEXT NOT NULL,
  account_alias TEXT NOT NULL,
  pool_scope TEXT NOT NULL CHECK (pool_scope IN ('shared', 'personal')),
  timestamp_ms INTEGER NOT NULL,
  source TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  thinking_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  cost_usd REAL,
  revision INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS usage_scope_time ON usage_events(pool_scope, timestamp_ms);
CREATE INDEX IF NOT EXISTS usage_device ON usage_events(device_id);
CREATE INDEX IF NOT EXISTS devices_member ON devices(member_id);

CREATE TABLE IF NOT EXISTS usage_retractions (
  device_id TEXT NOT NULL REFERENCES devices(device_id),
  event_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (device_id, event_id)
);

CREATE TABLE IF NOT EXISTS quota_snapshots (
  device_id TEXT NOT NULL REFERENCES devices(device_id),
  account_scope_key TEXT NOT NULL,
  account_alias TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  windows_json TEXT NOT NULL,
  PRIMARY KEY (device_id, account_scope_key)
);

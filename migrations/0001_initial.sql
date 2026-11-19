CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL DEFAULT 'Não informado',
  lives TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'novo' CHECK (stage IN ('novo','atendimento','cotacao','retorno','fechado')),
  next_return_at TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','site')),
  consent_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_stage_date ON leads(stage, next_return_at);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
CREATE TABLE IF NOT EXISTS request_limits (
  bucket TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_request_limits_lookup ON request_limits(bucket, key_hash, created_at);

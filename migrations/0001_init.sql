-- Big Picture: a life on one page.
--
-- Data model: a person has TRACKS. A track has a kind that decides what its rows mean:
--   span   -> items with start and optional end (school, jobs, places lived). Overlaps are allowed.
--   event  -> items with just a start (a move, a graduation, a trip, a breakup).
--   series -> one numeric value per day in `points` (weight, height, daily counts, mood).
-- Items carry free-form `attrs` JSON (employer, title, salary...), and a track's `config` JSON
-- says how to label, color and chart them. VIEWS pick which track is the main set of bars.

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  birth TEXT NOT NULL,                 -- YYYY-MM-DD
  profile TEXT NOT NULL DEFAULT '{}',  -- {life:{country,sex,adjust,e0}, ...}
  fail_count INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,                   -- short slug the MCP uses: "jobs", "places"
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('span','event','series')),
  color TEXT NOT NULL DEFAULT '#6b8afd',
  sort INTEGER NOT NULL DEFAULT 0,
  config TEXT NOT NULL DEFAULT '{}',
  UNIQUE (user_id, key)
);

CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  start TEXT NOT NULL,                 -- YYYY-MM-DD
  end TEXT,                            -- YYYY-MM-DD, null = event or still going
  label TEXT NOT NULL DEFAULT '',
  color TEXT,
  attrs TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX items_track ON items(track_id, start);
CREATE INDEX items_user ON items(user_id);

CREATE TABLE points (
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (track_id, date)
);
CREATE INDEX points_user ON points(user_id);

CREATE TABLE views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  config TEXT NOT NULL DEFAULT '{}',   -- {main, markers[], heat[], charts[]}
  UNIQUE (user_id, key)
);

-- OAuth 2.1 for the MCP server (same flow as Play With Food).
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  client_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX oauth_tokens_user ON oauth_tokens(user_id);

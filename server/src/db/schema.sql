-- Varisai schema (SPEC-LITE §5). Timestamps are epoch milliseconds.

CREATE TABLE IF NOT EXISTS users (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,
  name  TEXT,
  lang  TEXT NOT NULL DEFAULT 'en-IN'          -- Sarvam voice/translation language (§14.1)
);

CREATE TABLE IF NOT EXISTS weddings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  couple_names TEXT NOT NULL,
  venue_lat    REAL NOT NULL,
  venue_lng    REAL NOT NULL,
  radius_m     INTEGER NOT NULL DEFAULT 150,
  qr_secret    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  wedding_id INTEGER NOT NULL REFERENCES weddings(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  role       TEXT NOT NULL CHECK (role IN ('admin','booth_handler','guest')),
  side       TEXT CHECK (side IN ('bride','groom')),
  UNIQUE (wedding_id, user_id, role)
);

CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  wedding_id      INTEGER NOT NULL REFERENCES weddings(id),
  type            TEXT NOT NULL,
  name            TEXT NOT NULL,
  starts_at       INTEGER NOT NULL,
  ends_at         INTEGER NOT NULL,
  status_override TEXT NOT NULL DEFAULT 'auto' CHECK (status_override IN ('auto','live','ended')),
  sort_order      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS booths (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id          INTEGER NOT NULL REFERENCES events(id),
  name              TEXT NOT NULL,
  service_type      TEXT NOT NULL,
  code_prefix       TEXT NOT NULL,
  mode              TEXT NOT NULL CHECK (mode IN ('live','batch')),
  x_pct             REAL NOT NULL DEFAULT 50,
  y_pct             REAL NOT NULL DEFAULT 50,
  options_json      TEXT NOT NULL DEFAULT '[]',   -- [{label, minutes}]
  artists           INTEGER NOT NULL DEFAULT 1,
  round_seats       INTEGER,
  round_minutes     INTEGER,
  speed_factor      REAL NOT NULL DEFAULT 1.0,
  regulars_since_vip INTEGER NOT NULL DEFAULT 0,
  paused            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS booth_handlers (
  booth_id INTEGER NOT NULL REFERENCES booths(id),
  user_id  INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (booth_id, user_id)
);

CREATE TABLE IF NOT EXISTS pass_quotas (
  event_id   INTEGER NOT NULL REFERENCES events(id),
  side       TEXT NOT NULL CHECK (side IN ('bride','groom')),
  max_passes INTEGER NOT NULL,
  PRIMARY KEY (event_id, side)
);

CREATE TABLE IF NOT EXISTS family_passes (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  wedding_id         INTEGER NOT NULL REFERENCES weddings(id),
  side               TEXT NOT NULL CHECK (side IN ('bride','groom')),
  token              TEXT NOT NULL UNIQUE,
  label              TEXT NOT NULL,
  claimed_by_user_id INTEGER REFERENCES users(id),
  revoked_at         INTEGER
);

CREATE TABLE IF NOT EXISTS pass_events (
  pass_id  INTEGER NOT NULL REFERENCES family_passes(id),
  event_id INTEGER NOT NULL REFERENCES events(id),
  PRIMARY KEY (pass_id, event_id)
);

CREATE TABLE IF NOT EXISTS presence (
  user_id     INTEGER NOT NULL REFERENCES users(id),
  wedding_id  INTEGER NOT NULL REFERENCES weddings(id),
  valid_until INTEGER NOT NULL,
  PRIMARY KEY (user_id, wedding_id)
);

CREATE TABLE IF NOT EXISTS rounds (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  booth_id   INTEGER NOT NULL REFERENCES booths(id),
  round_no   INTEGER NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('seating','done')),
  started_at INTEGER NOT NULL,
  ends_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  booth_id     INTEGER NOT NULL REFERENCES booths(id),
  event_id     INTEGER NOT NULL REFERENCES events(id),
  user_id      INTEGER NOT NULL REFERENCES users(id),
  code         TEXT NOT NULL,                -- "M-014"
  option_label TEXT NOT NULL,
  base_minutes REAL NOT NULL,
  party_size   INTEGER NOT NULL DEFAULT 1,
  is_vip       INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL CHECK (status IN ('waiting','away','called','serving','done','no_show','cancelled')),
  seq          REAL NOT NULL,
  skip_count   INTEGER NOT NULL DEFAULT 0,
  round_id     INTEGER REFERENCES rounds(id),
  joined_at    INTEGER NOT NULL,
  called_at    INTEGER,
  serving_at   INTEGER,
  done_at      INTEGER,
  away_since   INTEGER
);

-- One active ticket per user per booth.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_per_booth ON tickets(user_id, booth_id)
  WHERE status IN ('waiting','away','called','serving');

-- Flagsmith eta_style A/B (§14.2): the variant a guest saw when joining, and whether they cancelled.
CREATE TABLE IF NOT EXISTS ab_eta (
  ticket_id INTEGER PRIMARY KEY REFERENCES tickets(id),
  variant   TEXT NOT NULL CHECK (variant IN ('minutes','people')),
  cancelled INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS tickets_by_booth_status ON tickets(booth_id, status);
CREATE INDEX IF NOT EXISTS tickets_by_user ON tickets(user_id, event_id);

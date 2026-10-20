-- Configurable push notifications.
-- Rules are data, not code: anything the cron evaluates is editable over MCP.

CREATE TABLE push_devices (
  id         TEXT PRIMARY KEY,        -- hash of the endpoint
  label      TEXT NOT NULL DEFAULT '',
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_ok_at TEXT,
  last_error TEXT,
  failures   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE notification_rules (
  id             TEXT PRIMARY KEY,
  label          TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  trigger_kind   TEXT NOT NULL CHECK (trigger_kind IN ('relative', 'digest')),

  -- relative: fire offset_minutes around each item's anchor instant
  anchor         TEXT NOT NULL DEFAULT 'due' CHECK (anchor IN ('due', 'release')),
  offset_minutes INTEGER NOT NULL DEFAULT 0,   -- negative = before the anchor

  -- digest: fire at a wall-clock time (Europe/Zurich) on the given weekdays
  at_time        TEXT NOT NULL DEFAULT '08:00',
  weekdays       TEXT NOT NULL DEFAULT '[]',   -- JSON [1..7]; [] = every day
  window_hours   INTEGER NOT NULL DEFAULT 48,
  include_overdue INTEGER NOT NULL DEFAULT 1,
  skip_if_empty  INTEGER NOT NULL DEFAULT 1,

  -- what the rule covers
  applies_to     TEXT NOT NULL DEFAULT 'all' CHECK (applies_to IN ('assignments', 'reviews', 'all')),
  course_ids     TEXT NOT NULL DEFAULT '[]',   -- JSON; [] = every course
  only_open      INTEGER NOT NULL DEFAULT 1,   -- skip items already done

  -- message, with {course} {title} {due} {left} {count} {list} placeholders
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,

  -- defer notifications landing inside quiet hours to quiet_until
  quiet_from     TEXT,
  quiet_until    TEXT,
  sort_order     INTEGER NOT NULL DEFAULT 0
);

-- One row per delivered notification, so a rule never fires twice for the same thing.
CREATE TABLE notification_log (
  key       TEXT PRIMARY KEY,         -- rule id + item/day key
  rule_id   TEXT NOT NULL,
  fired_at  TEXT NOT NULL,
  title     TEXT NOT NULL,
  body      TEXT NOT NULL,
  devices   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX notification_log_fired ON notification_log(fired_at);

INSERT INTO meta (key, value) VALUES ('push_last_run', '');

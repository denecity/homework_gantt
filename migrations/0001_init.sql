-- Current semester only. All instants are UTC ISO-8601 strings.

CREATE TABLE semester (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  name         TEXT NOT NULL,
  starts_on    TEXT NOT NULL,          -- YYYY-MM-DD (Europe/Zurich), start of view range
  ends_on      TEXT NOT NULL,          -- YYYY-MM-DD (Europe/Zurich), end of view range (inclusive)
  lectures_end_on TEXT,                -- YYYY-MM-DD, last lecture day (NULL = ends_on)
  review_hours INTEGER NOT NULL DEFAULT 48
);

CREATE TABLE courses (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  short      TEXT NOT NULL,
  color      TEXT NOT NULL,
  link       TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE markers (
  id        TEXT PRIMARY KEY,
  kind      TEXT NOT NULL CHECK (kind IN ('semester', 'break', 'exam', 'other')),
  label     TEXT NOT NULL,
  at        TEXT NOT NULL,
  end_at    TEXT,
  course_id TEXT REFERENCES courses(id) ON DELETE CASCADE
);

CREATE TABLE lecture_slots (
  id         TEXT PRIMARY KEY,
  course_id  TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  weekday    INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),  -- 1 = Monday
  start_time TEXT NOT NULL,            -- HH:MM Europe/Zurich
  end_time   TEXT NOT NULL,
  skip_dates TEXT NOT NULL DEFAULT '[]' -- JSON array of YYYY-MM-DD
);

CREATE TABLE series (
  id             TEXT PRIMARY KEY,
  course_id      TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title_template TEXT NOT NULL DEFAULT 'Sheet {n}',
  first_release  TEXT NOT NULL,        -- local YYYY-MM-DDTHH:MM (Europe/Zurich)
  first_due      TEXT NOT NULL,
  every_days     INTEGER NOT NULL DEFAULT 7,
  until          TEXT,                 -- YYYY-MM-DD; last release on or before this date. NULL = semester end
  start_number   INTEGER NOT NULL DEFAULT 1,
  skip_dates     TEXT NOT NULL DEFAULT '[]' -- release dates (YYYY-MM-DD) to skip; numbering continues
);

CREATE TABLE assignments (
  id         TEXT PRIMARY KEY,
  course_id  TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  series_id  TEXT REFERENCES series(id) ON DELETE SET NULL,
  seq        INTEGER,
  title      TEXT NOT NULL,
  release_at TEXT NOT NULL,
  due_at     TEXT NOT NULL,
  link       TEXT,
  notes      TEXT NOT NULL DEFAULT '',
  done       INTEGER NOT NULL DEFAULT 0,
  done_at    TEXT,
  detached   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX assignments_due ON assignments(due_at);
CREATE INDEX assignments_course ON assignments(course_id);

CREATE TABLE review_done (
  key     TEXT PRIMARY KEY,            -- '{slot_id}@{YYYY-MM-DD}'
  done_at TEXT NOT NULL
);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO meta (key, value) VALUES ('version', '1');

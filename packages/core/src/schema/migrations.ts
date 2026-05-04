// Ordered list of SQL migrations. Each entry is applied once and tracked
// in the `evolvr_migrations` table. Both SQLite and Postgres share the same
// migration text where possible; dialect differences are noted inline.

export interface Migration {
  version: number;
  name: string;
  sql: string; // ANSI SQL compatible with both SQLite and Postgres
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS evolvr_migrations (
        version   INTEGER PRIMARY KEY,
        name      TEXT    NOT NULL,
        applied_at TEXT   NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id               TEXT    PRIMARY KEY,
        agent            TEXT    NOT NULL,
        intent           TEXT    NOT NULL,
        plan_snapshot    TEXT,
        outcome          TEXT,
        outcome_detail   TEXT,
        failure_class    TEXT,
        reflection       TEXT,
        duration_ms      INTEGER,
        token_cost       INTEGER NOT NULL DEFAULT 0,
        parent_task_id   TEXT,
        session_id       TEXT    NOT NULL,
        agent_version    TEXT,
        started_at       TEXT    NOT NULL,
        ended_at         TEXT,
        FOREIGN KEY (parent_task_id) REFERENCES tasks(id)
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_agent        ON tasks(agent);
      CREATE INDEX IF NOT EXISTS idx_tasks_outcome      ON tasks(outcome);
      CREATE INDEX IF NOT EXISTS idx_tasks_started_at   ON tasks(started_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_session_id   ON tasks(session_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_failure_class ON tasks(failure_class);

      CREATE TABLE IF NOT EXISTS tool_calls (
        id               TEXT    PRIMARY KEY,
        task_id          TEXT    NOT NULL,
        seq              INTEGER NOT NULL,
        tool             TEXT    NOT NULL,
        args_hash        TEXT    NOT NULL,
        result_hash      TEXT    NOT NULL,
        result_summary   TEXT    NOT NULL DEFAULT '',
        latency_ms       INTEGER NOT NULL DEFAULT 0,
        repeated         INTEGER NOT NULL DEFAULT 0,
        was_loop_trigger INTEGER NOT NULL DEFAULT 0,
        token_cost       INTEGER NOT NULL DEFAULT 0,
        ts               TEXT    NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );

      CREATE INDEX IF NOT EXISTS idx_tool_calls_task_id  ON tool_calls(task_id);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_tool     ON tool_calls(tool);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_args_hash ON tool_calls(args_hash);

      CREATE TABLE IF NOT EXISTS lessons (
        id                    TEXT    PRIMARY KEY,
        failure_class         TEXT    NOT NULL,
        trigger_pattern       TEXT    NOT NULL,
        recommendation        TEXT    NOT NULL,
        confidence            REAL    NOT NULL DEFAULT 0.0,
        evidence_count        INTEGER NOT NULL DEFAULT 1,
        agent_scope           TEXT    NOT NULL DEFAULT '[]',
        promoted_to_agents_md INTEGER NOT NULL DEFAULT 0,
        created_at            TEXT    NOT NULL,
        last_seen_at          TEXT    NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_lessons_failure_class ON lessons(failure_class);
      CREATE INDEX IF NOT EXISTS idx_lessons_confidence    ON lessons(confidence);

      CREATE TABLE IF NOT EXISTS lesson_evidence (
        id         TEXT PRIMARY KEY,
        lesson_id  TEXT NOT NULL,
        task_id    TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (lesson_id) REFERENCES lessons(id),
        FOREIGN KEY (task_id)   REFERENCES tasks(id)
      );

      CREATE INDEX IF NOT EXISTS idx_evidence_lesson_id ON lesson_evidence(lesson_id);

      CREATE TABLE IF NOT EXISTS pending_lessons (
        id             TEXT PRIMARY KEY,
        task_id        TEXT NOT NULL,
        failure_class  TEXT NOT NULL,
        trigger_pattern TEXT NOT NULL,
        recommendation TEXT NOT NULL,
        confidence     REAL NOT NULL,
        reason         TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
    `,
  },
];

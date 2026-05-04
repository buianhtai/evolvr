import { Pool, type PoolClient } from 'pg';
import { ulid } from 'ulid';
import { createHash } from 'node:crypto';
import { MIGRATIONS } from '../schema/migrations.js';
import type { JournalAdapter, JournalStats } from '../journal.js';
import type {
  Task,
  StartTaskParams,
  CompleteTaskParams,
  ToolCallInput,
  ToolCall,
  Lesson,
  LessonUpsertParams,
  LessonQuery,
  FailureClass,
  AgentName,
} from '../types.js';

function now(): string {
  return new Date().toISOString();
}

function parseAgentScope(raw: string): AgentName[] {
  try { return JSON.parse(raw) as AgentName[]; } catch { return []; }
}

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row['id'] as string,
    agent: row['agent'] as AgentName,
    intent: row['intent'] as string,
    plan_snapshot: (row['plan_snapshot'] as string | null) ?? null,
    outcome: (row['outcome'] as Task['outcome']) ?? null,
    outcome_detail: (row['outcome_detail'] as string | null) ?? null,
    failure_class: (row['failure_class'] as FailureClass | null) ?? null,
    reflection: (row['reflection'] as string | null) ?? null,
    duration_ms: (row['duration_ms'] as number | null) ?? null,
    token_cost: Number(row['token_cost'] ?? 0),
    parent_task_id: (row['parent_task_id'] as string | null) ?? null,
    session_id: row['session_id'] as string,
    agent_version: (row['agent_version'] as string | null) ?? null,
    started_at: row['started_at'] as string,
    ended_at: (row['ended_at'] as string | null) ?? null,
  };
}

function rowToToolCall(row: Record<string, unknown>): ToolCall {
  return {
    id: row['id'] as string,
    task_id: row['task_id'] as string,
    seq: Number(row['seq']),
    tool: row['tool'] as string,
    args_hash: row['args_hash'] as string,
    result_hash: row['result_hash'] as string,
    result_summary: row['result_summary'] as string,
    latency_ms: Number(row['latency_ms']),
    repeated: Boolean(row['repeated']),
    was_loop_trigger: Boolean(row['was_loop_trigger']),
    token_cost: Number(row['token_cost'] ?? 0),
    ts: row['ts'] as string,
  };
}

function rowToLesson(row: Record<string, unknown>): Lesson {
  return {
    id: row['id'] as string,
    failure_class: row['failure_class'] as FailureClass,
    trigger_pattern: row['trigger_pattern'] as string,
    recommendation: row['recommendation'] as string,
    confidence: Number(row['confidence']),
    evidence_count: Number(row['evidence_count']),
    agent_scope: parseAgentScope(row['agent_scope'] as string),
    promoted_to_agents_md: Boolean(row['promoted_to_agents_md']),
    created_at: row['created_at'] as string,
    last_seen_at: row['last_seen_at'] as string,
  };
}

export function createPostgresAdapter(connectionString: string): PostgresAdapter {
  return new PostgresAdapter(connectionString);
}

export class PostgresAdapter implements JournalAdapter {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  private async query<T extends Record<string, unknown>>(
    sql: string,
    values: unknown[] = []
  ): Promise<T[]> {
    const res = await this.pool.query(sql, values);
    return res.rows as T[];
  }

  private async queryOne<T extends Record<string, unknown>>(
    sql: string,
    values: unknown[] = []
  ): Promise<T | null> {
    const rows = await this.query<T>(sql, values);
    return rows[0] ?? null;
  }

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS evolvr_migrations (
        version    INTEGER PRIMARY KEY,
        name       TEXT    NOT NULL,
        applied_at TEXT    NOT NULL
      )
    `);

    const res = await this.pool.query('SELECT version FROM evolvr_migrations');
    const applied = new Set<number>(res.rows.map((r: { version: number }) => r.version));

    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      // Postgres uses BOOLEAN instead of INTEGER for booleans —
      // replace the SQLite-compat INTEGER columns inline
      const pgSql = m.sql
        .replace(/repeated\s+INTEGER/g, 'repeated BOOLEAN')
        .replace(/was_loop_trigger\s+INTEGER/g, 'was_loop_trigger BOOLEAN')
        .replace(/promoted_to_agents_md\s+INTEGER/g, 'promoted_to_agents_md BOOLEAN');
      await this.pool.query(pgSql);
      await this.pool.query(
        'INSERT INTO evolvr_migrations (version, name, applied_at) VALUES ($1, $2, $3)',
        [m.version, m.name, now()]
      );
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // ── Tasks ──────────────────────────────────────────────────────────────────

  async startTask(params: StartTaskParams): Promise<Task> {
    const id = params.id ?? ulid();
    const session_id = params.session_id ?? ulid();
    const ts = now();
    await this.pool.query(
      `INSERT INTO tasks
         (id, agent, intent, plan_snapshot, session_id, parent_task_id, agent_version, started_at, token_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0)`,
      [id, params.agent, params.intent, params.plan_snapshot ?? null,
       session_id, params.parent_task_id ?? null, params.agent_version ?? null, ts]
    );
    const row = await this.queryOne<Record<string, unknown>>('SELECT * FROM tasks WHERE id = $1', [id]);
    return rowToTask(row!);
  }

  async completeTask(taskId: string, params: CompleteTaskParams): Promise<Task> {
    const ts = now();
    const startedRow = await this.queryOne<{ started_at: string }>(
      'SELECT started_at FROM tasks WHERE id = $1', [taskId]
    );
    const duration_ms = startedRow
      ? new Date(ts).getTime() - new Date(startedRow.started_at).getTime()
      : 0;
    await this.pool.query(
      `UPDATE tasks SET outcome=$1, outcome_detail=$2, reflection=$3,
         token_cost=$4, duration_ms=$5, ended_at=$6 WHERE id=$7`,
      [params.outcome, params.outcome_detail ?? null, params.reflection ?? null,
       params.token_cost ?? 0, duration_ms, ts, taskId]
    );
    const row = await this.queryOne<Record<string, unknown>>('SELECT * FROM tasks WHERE id = $1', [taskId]);
    return rowToTask(row!);
  }

  async updateTaskFailureClass(taskId: string, failureClass: FailureClass): Promise<void> {
    await this.pool.query('UPDATE tasks SET failure_class = $1 WHERE id = $2', [failureClass, taskId]);
  }

  async getTask(taskId: string): Promise<Task | null> {
    const row = await this.queryOne<Record<string, unknown>>('SELECT * FROM tasks WHERE id = $1', [taskId]);
    return row ? rowToTask(row) : null;
  }

  async listTasks(opts: { agent?: AgentName; outcome?: string; limit?: number; offset?: number } = {}): Promise<Task[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (opts.agent) { conditions.push(`agent = $${i++}`); values.push(opts.agent); }
    if (opts.outcome) { conditions.push(`outcome = $${i++}`); values.push(opts.outcome); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(opts.limit ?? 50, opts.offset ?? 0);
    const rows = await this.query<Record<string, unknown>>(
      `SELECT * FROM tasks ${where} ORDER BY started_at DESC LIMIT $${i} OFFSET $${i + 1}`,
      values
    );
    return rows.map(rowToTask);
  }

  // ── Tool calls ─────────────────────────────────────────────────────────────

  async recordToolCall(taskId: string, call: ToolCallInput): Promise<ToolCall> {
    const id = ulid();
    const ts = now();
    await this.pool.query(
      `INSERT INTO tool_calls
         (id, task_id, seq, tool, args_hash, result_hash, result_summary,
          latency_ms, repeated, was_loop_trigger, token_cost, ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, taskId, call.seq, call.tool,
       call.args_hash, call.result_hash, call.result_summary,
       call.latency_ms, call.repeated ?? false, call.was_loop_trigger ?? false,
       call.token_cost ?? 0, ts]
    );
    const row = await this.queryOne<Record<string, unknown>>('SELECT * FROM tool_calls WHERE id = $1', [id]);
    return rowToToolCall(row!);
  }

  async getToolCallsForTask(taskId: string): Promise<ToolCall[]> {
    const rows = await this.query<Record<string, unknown>>(
      'SELECT * FROM tool_calls WHERE task_id = $1 ORDER BY seq ASC',
      [taskId]
    );
    return rows.map(rowToToolCall);
  }

  // ── Lessons ────────────────────────────────────────────────────────────────

  async upsertLesson(params: LessonUpsertParams): Promise<Lesson> {
    const ts = now();
    const existing = await this.queryOne<Record<string, unknown>>(
      `SELECT * FROM lessons WHERE failure_class = $1 AND substr(trigger_pattern, 1, 80) = $2`,
      [params.failure_class, params.trigger_pattern.slice(0, 80)]
    );

    if (existing) {
      const id = existing['id'] as string;
      const newCount = (existing['evidence_count'] as number) + 1;
      const existingScope = parseAgentScope(existing['agent_scope'] as string);
      const mergedScope = [...new Set([...existingScope, ...params.agent_scope])];
      await this.pool.query(
        `UPDATE lessons SET evidence_count=$1, confidence=$2, agent_scope=$3,
           recommendation=$4, last_seen_at=$5 WHERE id=$6`,
        [newCount, params.confidence, JSON.stringify(mergedScope), params.recommendation, ts, id]
      );
      await this.pool.query(
        'INSERT INTO lesson_evidence (id, lesson_id, task_id, created_at) VALUES ($1,$2,$3,$4)',
        [ulid(), id, params.evidence_task_id, ts]
      );
      const row = await this.queryOne<Record<string, unknown>>('SELECT * FROM lessons WHERE id = $1', [id]);
      return rowToLesson(row!);
    }

    const id = ulid();
    await this.pool.query(
      `INSERT INTO lessons
         (id, failure_class, trigger_pattern, recommendation, confidence,
          evidence_count, agent_scope, promoted_to_agents_md, created_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,1,$6,false,$7,$8)`,
      [id, params.failure_class, params.trigger_pattern, params.recommendation,
       params.confidence, JSON.stringify(params.agent_scope), ts, ts]
    );
    await this.pool.query(
      'INSERT INTO lesson_evidence (id, lesson_id, task_id, created_at) VALUES ($1,$2,$3,$4)',
      [ulid(), id, params.evidence_task_id, ts]
    );
    const row = await this.queryOne<Record<string, unknown>>('SELECT * FROM lessons WHERE id = $1', [id]);
    return rowToLesson(row!);
  }

  async getLessons(query: LessonQuery = {}): Promise<Lesson[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (query.agent) { conditions.push(`agent_scope LIKE $${i++}`); values.push(`%"${query.agent}"%`); }
    if (query.min_confidence !== undefined) { conditions.push(`confidence >= $${i++}`); values.push(query.min_confidence); }
    if (query.failure_class) { conditions.push(`failure_class = $${i++}`); values.push(query.failure_class); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(query.limit ?? 20);
    const rows = await this.query<Record<string, unknown>>(
      `SELECT * FROM lessons ${where} ORDER BY evidence_count DESC, confidence DESC LIMIT $${i}`,
      values
    );
    return rows.map(rowToLesson);
  }

  async markLessonPromoted(lessonId: string): Promise<void> {
    await this.pool.query('UPDATE lessons SET promoted_to_agents_md = true WHERE id = $1', [lessonId]);
  }

  async addPendingLesson(params: {
    task_id: string;
    failure_class: FailureClass;
    trigger_pattern: string;
    recommendation: string;
    confidence: number;
    reason: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO pending_lessons
         (id, task_id, failure_class, trigger_pattern, recommendation, confidence, reason, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ulid(), params.task_id, params.failure_class,
       params.trigger_pattern, params.recommendation,
       params.confidence, params.reason, now()]
    );
  }

  async stats(): Promise<JournalStats> {
    const [total, failed, success, lessons, pending] = await Promise.all([
      this.queryOne<{ n: string }>('SELECT COUNT(*) as n FROM tasks'),
      this.queryOne<{ n: string }>(`SELECT COUNT(*) as n FROM tasks WHERE outcome IN ('failed','loop_stopped')`),
      this.queryOne<{ n: string }>(`SELECT COUNT(*) as n FROM tasks WHERE outcome = 'success'`),
      this.queryOne<{ n: string }>('SELECT COUNT(*) as n FROM lessons'),
      this.queryOne<{ n: string }>('SELECT COUNT(*) as n FROM pending_lessons'),
    ]);
    const agentRows = await this.query<{ agent: string; n: string }>(
      'SELECT agent, COUNT(*) as n FROM tasks GROUP BY agent'
    );
    const agents: Record<string, number> = {};
    for (const r of agentRows) agents[r.agent] = Number(r.n);
    return {
      total_tasks: Number(total?.n ?? 0),
      failed_tasks: Number(failed?.n ?? 0),
      success_tasks: Number(success?.n ?? 0),
      total_lessons: Number(lessons?.n ?? 0),
      pending_lessons: Number(pending?.n ?? 0),
      agents,
    };
  }
}

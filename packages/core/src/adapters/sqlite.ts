import { createClient, type Client } from '@libsql/client';
import { ulid } from 'ulid';
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

export function createSqliteAdapter(dbPath: string): SqliteAdapter {
  return new SqliteAdapter(dbPath);
}

function now(): string {
  return new Date().toISOString();
}

function asBool(v: unknown): boolean {
  return v === 1 || v === true || v === '1' || v === 'true';
}

function parseAgentScope(raw: unknown): AgentName[] {
  if (!raw) return [];
  try { return JSON.parse(raw as string) as AgentName[]; } catch { return []; }
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
    duration_ms: row['duration_ms'] != null ? Number(row['duration_ms']) : null,
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
    repeated: asBool(row['repeated']),
    was_loop_trigger: asBool(row['was_loop_trigger']),
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
    agent_scope: parseAgentScope(row['agent_scope']),
    promoted_to_agents_md: asBool(row['promoted_to_agents_md']),
    created_at: row['created_at'] as string,
    last_seen_at: row['last_seen_at'] as string,
  };
}

export class SqliteAdapter implements JournalAdapter {
  private db: Client;

  constructor(dbPath: string) {
    // @libsql/client accepts file:// URLs or plain paths
    const url = dbPath.startsWith('file:') ? dbPath : `file:${dbPath}`;
    this.db = createClient({ url });
  }

  async migrate(): Promise<void> {
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS evolvr_migrations (
        version    INTEGER PRIMARY KEY,
        name       TEXT    NOT NULL,
        applied_at TEXT    NOT NULL
      )
    `);

    const res = await this.db.execute('SELECT version FROM evolvr_migrations');
    const applied = new Set<number>(res.rows.map((r) => Number(r['version'])));

    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      // Execute each statement separately (libsql doesn't support multi-statement strings)
      for (const stmt of m.sql.split(';').map((s) => s.trim()).filter(Boolean)) {
        await this.db.execute(stmt);
      }
      await this.db.execute({
        sql: 'INSERT INTO evolvr_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        args: [m.version, m.name, now()],
      });
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }

  // ── Tasks ──────────────────────────────────────────────────────────────────

  async startTask(params: StartTaskParams): Promise<Task> {
    const id = params.id ?? ulid();
    const session_id = params.session_id ?? ulid();
    const ts = now();
    await this.db.execute({
      sql: `INSERT INTO tasks
        (id, agent, intent, plan_snapshot, session_id, parent_task_id, agent_version, started_at, token_cost)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      args: [id, params.agent, params.intent, params.plan_snapshot ?? null,
             session_id, params.parent_task_id ?? null, params.agent_version ?? null, ts],
    });
    const row = await this.db.execute({ sql: 'SELECT * FROM tasks WHERE id = ?', args: [id] });
    return rowToTask(row.rows[0] as Record<string, unknown>);
  }

  async completeTask(taskId: string, params: CompleteTaskParams): Promise<Task> {
    const ts = now();
    const startedRes = await this.db.execute({
      sql: 'SELECT started_at FROM tasks WHERE id = ?',
      args: [taskId],
    });
    const started = (startedRes.rows[0]?.['started_at'] as string | undefined) ?? ts;
    const duration_ms = new Date(ts).getTime() - new Date(started).getTime();

    await this.db.execute({
      sql: `UPDATE tasks SET
        outcome = ?, outcome_detail = ?, reflection = ?,
        token_cost = ?, duration_ms = ?, ended_at = ?
        WHERE id = ?`,
      args: [params.outcome, params.outcome_detail ?? null, params.reflection ?? null,
             params.token_cost ?? 0, duration_ms, ts, taskId],
    });
    const row = await this.db.execute({ sql: 'SELECT * FROM tasks WHERE id = ?', args: [taskId] });
    return rowToTask(row.rows[0] as Record<string, unknown>);
  }

  async updateTaskFailureClass(taskId: string, failureClass: FailureClass): Promise<void> {
    await this.db.execute({
      sql: 'UPDATE tasks SET failure_class = ? WHERE id = ?',
      args: [failureClass, taskId],
    });
  }

  async getTask(taskId: string): Promise<Task | null> {
    const res = await this.db.execute({ sql: 'SELECT * FROM tasks WHERE id = ?', args: [taskId] });
    return res.rows[0] ? rowToTask(res.rows[0] as Record<string, unknown>) : null;
  }

  async listTasks(opts: { agent?: AgentName; outcome?: string; limit?: number; offset?: number } = {}): Promise<Task[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (opts.agent) { conditions.push('agent = ?'); values.push(opts.agent); }
    if (opts.outcome) { conditions.push('outcome = ?'); values.push(opts.outcome); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    values.push(limit, offset);
    const res = await this.db.execute({
      sql: `SELECT * FROM tasks ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
      args: values as import('@libsql/client').InValue[],
    });
    return res.rows.map((r) => rowToTask(r as Record<string, unknown>));
  }

  // ── Tool calls ─────────────────────────────────────────────────────────────

  async recordToolCall(taskId: string, call: ToolCallInput): Promise<ToolCall> {
    const id = ulid();
    const ts = now();
    await this.db.execute({
      sql: `INSERT INTO tool_calls
        (id, task_id, seq, tool, args_hash, result_hash, result_summary,
         latency_ms, repeated, was_loop_trigger, token_cost, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, taskId, call.seq, call.tool,
             call.args_hash, call.result_hash, call.result_summary,
             call.latency_ms, call.repeated ? 1 : 0, call.was_loop_trigger ? 1 : 0,
             call.token_cost ?? 0, ts],
    });
    const res = await this.db.execute({ sql: 'SELECT * FROM tool_calls WHERE id = ?', args: [id] });
    return rowToToolCall(res.rows[0] as Record<string, unknown>);
  }

  async getToolCallsForTask(taskId: string): Promise<ToolCall[]> {
    const res = await this.db.execute({
      sql: 'SELECT * FROM tool_calls WHERE task_id = ? ORDER BY seq ASC',
      args: [taskId],
    });
    return res.rows.map((r) => rowToToolCall(r as Record<string, unknown>));
  }

  // ── Lessons ────────────────────────────────────────────────────────────────

  async upsertLesson(params: LessonUpsertParams): Promise<Lesson> {
    const ts = now();
    const existingRes = await this.db.execute({
      sql: `SELECT * FROM lessons WHERE failure_class = ? AND substr(trigger_pattern, 1, 80) = ?`,
      args: [params.failure_class, params.trigger_pattern.slice(0, 80)],
    });
    const existing = existingRes.rows[0] as Record<string, unknown> | undefined;

    if (existing) {
      const id = existing['id'] as string;
      const newCount = Number(existing['evidence_count']) + 1;
      const existingScope = parseAgentScope(existing['agent_scope']);
      const mergedScope = [...new Set([...existingScope, ...params.agent_scope])];
      await this.db.execute({
        sql: `UPDATE lessons SET evidence_count = ?, confidence = ?, agent_scope = ?,
               recommendation = ?, last_seen_at = ? WHERE id = ?`,
        args: [newCount, params.confidence, JSON.stringify(mergedScope), params.recommendation, ts, id],
      });
      await this.db.execute({
        sql: 'INSERT INTO lesson_evidence (id, lesson_id, task_id, created_at) VALUES (?, ?, ?, ?)',
        args: [ulid(), id, params.evidence_task_id, ts],
      });
      const row = await this.db.execute({ sql: 'SELECT * FROM lessons WHERE id = ?', args: [id] });
      return rowToLesson(row.rows[0] as Record<string, unknown>);
    }

    const id = ulid();
    await this.db.execute({
      sql: `INSERT INTO lessons
        (id, failure_class, trigger_pattern, recommendation, confidence,
         evidence_count, agent_scope, promoted_to_agents_md, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, 0, ?, ?)`,
      args: [id, params.failure_class, params.trigger_pattern, params.recommendation,
             params.confidence, JSON.stringify(params.agent_scope), ts, ts],
    });
    await this.db.execute({
      sql: 'INSERT INTO lesson_evidence (id, lesson_id, task_id, created_at) VALUES (?, ?, ?, ?)',
      args: [ulid(), id, params.evidence_task_id, ts],
    });
    const row = await this.db.execute({ sql: 'SELECT * FROM lessons WHERE id = ?', args: [id] });
    return rowToLesson(row.rows[0] as Record<string, unknown>);
  }

  async getLessons(query: LessonQuery = {}): Promise<Lesson[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (query.agent) { conditions.push(`agent_scope LIKE ?`); values.push(`%"${query.agent}"%`); }
    if (query.min_confidence !== undefined) { conditions.push('confidence >= ?'); values.push(query.min_confidence); }
    if (query.failure_class) { conditions.push('failure_class = ?'); values.push(query.failure_class); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = query.limit ?? 20;
    values.push(limit);
    const res = await this.db.execute({
      sql: `SELECT * FROM lessons ${where} ORDER BY evidence_count DESC, confidence DESC LIMIT ?`,
      args: values as import('@libsql/client').InValue[],
    });
    return res.rows.map((r) => rowToLesson(r as Record<string, unknown>));
  }

  async markLessonPromoted(lessonId: string): Promise<void> {
    await this.db.execute({
      sql: 'UPDATE lessons SET promoted_to_agents_md = 1 WHERE id = ?',
      args: [lessonId],
    });
  }

  async addPendingLesson(params: {
    task_id: string;
    failure_class: FailureClass;
    trigger_pattern: string;
    recommendation: string;
    confidence: number;
    reason: string;
  }): Promise<void> {
    await this.db.execute({
      sql: `INSERT INTO pending_lessons
        (id, task_id, failure_class, trigger_pattern, recommendation, confidence, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [ulid(), params.task_id, params.failure_class,
             params.trigger_pattern, params.recommendation,
             params.confidence, params.reason, now()],
    });
  }

  async stats(): Promise<JournalStats> {
    const [totalRes, failedRes, successRes, lessonsRes, pendingRes] = await Promise.all([
      this.db.execute('SELECT COUNT(*) as n FROM tasks'),
      this.db.execute(`SELECT COUNT(*) as n FROM tasks WHERE outcome IN ('failed','loop_stopped')`),
      this.db.execute(`SELECT COUNT(*) as n FROM tasks WHERE outcome = 'success'`),
      this.db.execute('SELECT COUNT(*) as n FROM lessons'),
      this.db.execute('SELECT COUNT(*) as n FROM pending_lessons'),
    ]);
    const agentRes = await this.db.execute(
      'SELECT agent, COUNT(*) as n FROM tasks GROUP BY agent'
    );
    const agents: Record<string, number> = {};
    for (const r of agentRes.rows) agents[r['agent'] as string] = Number(r['n']);

    return {
      total_tasks: Number(totalRes.rows[0]?.['n'] ?? 0),
      failed_tasks: Number(failedRes.rows[0]?.['n'] ?? 0),
      success_tasks: Number(successRes.rows[0]?.['n'] ?? 0),
      total_lessons: Number(lessonsRes.rows[0]?.['n'] ?? 0),
      pending_lessons: Number(pendingRes.rows[0]?.['n'] ?? 0),
      agents,
    };
  }
}

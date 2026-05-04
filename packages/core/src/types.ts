// ─── Agents ──────────────────────────────────────────────────────────────────

export type AgentName = 'claude' | 'opencode' | 'codex' | 'pi' | string;

// ─── Failure taxonomy ────────────────────────────────────────────────────────

export type FailureClass =
  | 'exact_repeat_loop'
  | 'read_only_streak'
  | 'same_result_cycling'
  | 'context_overflow'
  | 'tool_permission_denied'
  | 'external_service_error'
  | 'wrong_tool_sequence'
  | 'missing_context'
  | 'ambiguous_intent'
  | 'unknown';

export type Outcome = 'success' | 'partial' | 'failed' | 'loop_stopped';

// ─── Tool calls ──────────────────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  task_id: string;
  seq: number;
  tool: string;
  args_hash: string;       // SHA-256 of JSON-stringified args
  result_hash: string;     // SHA-256 of JSON-stringified result
  result_summary: string;  // first 200 chars of result text
  latency_ms: number;
  repeated: boolean;
  was_loop_trigger: boolean;
  token_cost: number;
  ts: string;              // ISO8601
}

export interface ToolCallInput {
  seq: number;
  tool: string;
  args_hash: string;
  result_hash: string;
  result_summary: string;
  latency_ms: number;
  repeated?: boolean;
  was_loop_trigger?: boolean;
  token_cost?: number;
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

export interface Task {
  id: string;
  agent: AgentName;
  intent: string;
  plan_snapshot: string | null;
  outcome: Outcome | null;
  outcome_detail: string | null;
  failure_class: FailureClass | null;
  reflection: string | null;
  duration_ms: number | null;
  token_cost: number;
  parent_task_id: string | null;
  session_id: string;
  agent_version: string | null;
  started_at: string;
  ended_at: string | null;
  tool_calls?: ToolCall[];
}

export interface StartTaskParams {
  id?: string;
  agent: AgentName;
  intent: string;
  session_id?: string;
  parent_task_id?: string;
  agent_version?: string;
  plan_snapshot?: string;
}

export interface CompleteTaskParams {
  outcome: Outcome;
  outcome_detail?: string;
  reflection?: string;
  token_cost?: number;
}

// ─── Lessons ─────────────────────────────────────────────────────────────────

export interface Lesson {
  id: string;
  failure_class: FailureClass;
  trigger_pattern: string;
  recommendation: string;
  confidence: number;
  evidence_count: number;
  agent_scope: AgentName[];
  promoted_to_agents_md: boolean;
  created_at: string;
  last_seen_at: string;
}

export interface LessonUpsertParams {
  failure_class: FailureClass;
  trigger_pattern: string;
  recommendation: string;
  confidence: number;
  agent_scope: AgentName[];
  evidence_task_id: string;
}

export interface LessonQuery {
  agent?: AgentName;
  min_confidence?: number;
  failure_class?: FailureClass;
  limit?: number;
}

// ─── Classifier results ───────────────────────────────────────────────────────

export interface ClassifierResult {
  failure_class: FailureClass;
  confidence: number;
  trigger_pattern: string;
  recommendation: string;
  trigger_tool?: string;
  trigger_count?: number;
}

// ─── Config ──────────────────────────────────────────────────────────────────

export type StorageType = 'sqlite' | 'postgres';

export interface EvolvrConfig {
  storage: StorageType;
  sqlite_path?: string;        // default: .evolvr/evolvr.db
  postgres_url?: string;
  agents: AgentName[];
  auto_evolve: boolean;
  min_confidence: number;      // default: 0.6
  min_evidence: number;        // default: 3
  lesson_injection: boolean;
  max_lessons_per_session: number;
  classifier: ClassifierConfig;
}

export interface ClassifierConfig {
  stage1_enabled: boolean;
  stage2_enabled: boolean;
  stage2_model: string;
  confidence_threshold: number;
  pending_threshold: number;
  thresholds: {
    exact_repeat_warning: number;
    exact_repeat_critical: number;
    read_only_streak_warning: number;
    read_only_streak_critical: number;
    same_result_warning: number;
    same_result_critical: number;
  };
}

export const DEFAULT_CONFIG: EvolvrConfig = {
  storage: 'sqlite',
  agents: ['claude', 'opencode', 'codex', 'pi'],
  auto_evolve: false,
  min_confidence: 0.6,
  min_evidence: 3,
  lesson_injection: true,
  max_lessons_per_session: 5,
  classifier: {
    stage1_enabled: true,
    stage2_enabled: false,
    stage2_model: 'claude-3-5-haiku-20241022',
    confidence_threshold: 0.6,
    pending_threshold: 0.35,
    thresholds: {
      exact_repeat_warning: 3,
      exact_repeat_critical: 5,
      read_only_streak_warning: 8,
      read_only_streak_critical: 12,
      same_result_warning: 4,
      same_result_critical: 6,
    },
  },
};

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
} from './types.js';

// ─── Adapter interface ───────────────────────────────────────────────────────

export interface JournalAdapter {
  /** Apply all pending migrations. Must be called once after connect. */
  migrate(): Promise<void>;
  close(): Promise<void>;

  // Tasks
  startTask(params: StartTaskParams): Promise<Task>;
  completeTask(taskId: string, params: CompleteTaskParams): Promise<Task>;
  updateTaskFailureClass(taskId: string, failureClass: FailureClass): Promise<void>;
  getTask(taskId: string): Promise<Task | null>;
  listTasks(opts?: { agent?: AgentName; outcome?: string; limit?: number; offset?: number }): Promise<Task[]>;

  // Tool calls
  recordToolCall(taskId: string, call: ToolCallInput): Promise<ToolCall>;
  getToolCallsForTask(taskId: string): Promise<ToolCall[]>;

  // Lessons
  upsertLesson(params: LessonUpsertParams): Promise<Lesson>;
  getLessons(query?: LessonQuery): Promise<Lesson[]>;
  markLessonPromoted(lessonId: string): Promise<void>;

  // Pending lessons
  addPendingLesson(params: {
    task_id: string;
    failure_class: FailureClass;
    trigger_pattern: string;
    recommendation: string;
    confidence: number;
    reason: string;
  }): Promise<void>;

  // Stats
  stats(): Promise<JournalStats>;
}

export interface JournalStats {
  total_tasks: number;
  failed_tasks: number;
  success_tasks: number;
  total_lessons: number;
  pending_lessons: number;
  agents: Record<string, number>;
}

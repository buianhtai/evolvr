import type { JournalAdapter } from './journal.js';
import type {
  Task,
  StartTaskParams,
  CompleteTaskParams,
  ToolCallInput,
  ToolCall,
  Lesson,
  LessonQuery,
  EvolvrConfig,
  AgentName,
} from './types.js';
import { classifyToolCalls } from './classifier.js';

export class Evolvr {
  constructor(
    private readonly adapter: JournalAdapter,
    private readonly config: EvolvrConfig,
  ) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    await this.adapter.migrate();
  }

  async close(): Promise<void> {
    await this.adapter.close();
  }

  // ── Task tracking ──────────────────────────────────────────────────────────

  async startTask(params: StartTaskParams): Promise<Task> {
    return this.adapter.startTask(params);
  }

  async recordToolCall(taskId: string, call: ToolCallInput): Promise<ToolCall> {
    return this.adapter.recordToolCall(taskId, call);
  }

  /**
   * Complete a task, run the classifier, store lessons.
   * Returns the final Task record.
   */
  async completeTask(taskId: string, params: CompleteTaskParams): Promise<Task> {
    const task = await this.adapter.completeTask(taskId, params);

    if (params.outcome !== 'success') {
      await this.runClassification(task);
    }

    return task;
  }

  // ── Classification ─────────────────────────────────────────────────────────

  private async runClassification(task: Task): Promise<void> {
    const calls = await this.adapter.getToolCallsForTask(task.id);
    if (calls.length === 0) return;

    const { result } = classifyToolCalls(calls, this.config.classifier);
    if (!result) return;

    await this.adapter.updateTaskFailureClass(task.id, result.failure_class);

    if (result.confidence >= this.config.classifier.confidence_threshold) {
      await this.adapter.upsertLesson({
        failure_class: result.failure_class,
        trigger_pattern: result.trigger_pattern,
        recommendation: result.recommendation,
        confidence: result.confidence,
        agent_scope: [task.agent],
        evidence_task_id: task.id,
      });
    } else if (result.confidence >= this.config.classifier.pending_threshold) {
      await this.adapter.addPendingLesson({
        task_id: task.id,
        failure_class: result.failure_class,
        trigger_pattern: result.trigger_pattern,
        recommendation: result.recommendation,
        confidence: result.confidence,
        reason: `confidence ${result.confidence.toFixed(2)} below threshold ${this.config.classifier.confidence_threshold}`,
      });
    }
  }

  // ── Lessons ────────────────────────────────────────────────────────────────

  async getLessons(query?: LessonQuery): Promise<Lesson[]> {
    return this.adapter.getLessons({
      min_confidence: this.config.min_confidence,
      limit: this.config.max_lessons_per_session,
      ...query,
    });
  }

  async getLessonsForAgent(agent: AgentName): Promise<Lesson[]> {
    return this.getLessons({ agent });
  }

  /** Format lessons as a compact system message for injection. */
  formatLessonsForInjection(lessons: Lesson[]): string {
    if (lessons.length === 0) return '';
    const lines = ['[evolvr] Learned behaviors relevant to this session:'];
    for (const l of lessons) {
      lines.push(`- ${l.failure_class}: ${l.recommendation}`);
    }
    return lines.join('\n');
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  async stats() {
    return this.adapter.stats();
  }

  // ── Task queries ───────────────────────────────────────────────────────────

  async listTasks(opts?: { agent?: AgentName; outcome?: string; limit?: number }) {
    return this.adapter.listTasks(opts);
  }

  async getTask(id: string) {
    return this.adapter.getTask(id);
  }

  async getToolCallsForTask(taskId: string): Promise<ToolCall[]> {
    return this.adapter.getToolCallsForTask(taskId);
  }
}

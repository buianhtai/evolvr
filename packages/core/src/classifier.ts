import type { ToolCall, ClassifierResult, ClassifierConfig } from './types.js';

// Read-only tools — these do not mutate state.
// exec/bash are intentionally excluded (intent is opaque).
const MUTATING_TOOLS = new Set([
  'write_file', 'write', 'edit', 'edit_file', 'create_file',
  'str_replace_editor', 'str_replace_based_edit_tool',
  'spawn', 'team_tasks', 'message', 'send_message',
  'create_image', 'create_video', 'create_audio',
  'tts', 'cron', 'publish_skill', 'sessions_send',
  // OpenCode / Claude Code specific
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
]);

// ─── Detector 1: Exact-repeat loop ──────────────────────────────────────────

function detectExactRepeat(
  calls: ToolCall[],
  thresholds: ClassifierConfig['thresholds'],
): ClassifierResult | null {
  // key: "tool:argsHash:resultHash"
  const seen = new Map<string, { count: number; tool: string }>();

  for (const call of calls) {
    if (!call.result_hash) continue;
    const key = `${call.tool}:${call.args_hash}:${call.result_hash}`;
    const entry = seen.get(key) ?? { count: 0, tool: call.tool };
    entry.count += 1;
    seen.set(key, entry);
  }

  let best: { count: number; tool: string } | null = null;
  for (const entry of seen.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  if (!best) return null;

  if (best.count >= thresholds.exact_repeat_critical) {
    return {
      failure_class: 'exact_repeat_loop',
      confidence: 1.0,
      trigger_count: best.count,
      trigger_tool: best.tool,
      trigger_pattern: `Tool "${best.tool}" was called ${best.count} times with identical arguments and produced identical results.`,
      recommendation: `When "${best.tool}" returns the same result on repeated calls, stop and re-evaluate the approach. The result will not change.`,
    };
  }
  if (best.count >= thresholds.exact_repeat_warning) {
    return {
      failure_class: 'exact_repeat_loop',
      confidence: 0.8,
      trigger_count: best.count,
      trigger_tool: best.tool,
      trigger_pattern: `Tool "${best.tool}" was called ${best.count} times with identical arguments and results.`,
      recommendation: `Repeated identical calls to "${best.tool}" indicate a loop. After 2 identical results, change strategy.`,
    };
  }
  return null;
}

// ─── Detector 2: Read-only streak ────────────────────────────────────────────

function detectReadOnlyStreak(
  calls: ToolCall[],
  thresholds: ClassifierConfig['thresholds'],
): ClassifierResult | null {
  let streak = 0;
  let maxStreak = 0;
  let streakTools: string[] = [];
  let longestStreakTools: string[] = [];

  for (const call of calls) {
    if (MUTATING_TOOLS.has(call.tool)) {
      streak = 0;
      streakTools = [];
    } else if (call.tool !== 'exec' && call.tool !== 'bash' && call.tool !== 'Bash') {
      streak += 1;
      streakTools.push(call.tool);
      if (streak > maxStreak) {
        maxStreak = streak;
        longestStreakTools = [...streakTools];
      }
    }
    // exec/bash: neutral — don't reset or increment
  }

  if (maxStreak >= thresholds.read_only_streak_critical) {
    const uniq = [...new Set(longestStreakTools)].join(', ');
    return {
      failure_class: 'read_only_streak',
      confidence: 1.0,
      trigger_count: maxStreak,
      trigger_tool: 'multiple',
      trigger_pattern: `${maxStreak} consecutive read-only tool calls without any mutation (tools: ${uniq}).`,
      recommendation: `A long read-only streak means the agent is gathering information but not acting. After 6 read operations, commit to a plan and start writing.`,
    };
  }
  if (maxStreak >= thresholds.read_only_streak_warning) {
    return {
      failure_class: 'read_only_streak',
      confidence: 0.75,
      trigger_count: maxStreak,
      trigger_tool: 'multiple',
      trigger_pattern: `${maxStreak} consecutive read-only calls without mutation.`,
      recommendation: `Long read-only streaks suggest analysis paralysis. After 5 reads, take action.`,
    };
  }
  return null;
}

// ─── Detector 3: Same-result cycling ─────────────────────────────────────────

function detectSameResultCycling(
  calls: ToolCall[],
  thresholds: ClassifierConfig['thresholds'],
): ClassifierResult | null {
  // Per tool: result_hash → Set<args_hash>
  const byTool = new Map<string, Map<string, Set<string>>>();

  for (const call of calls) {
    if (!call.result_hash || !call.args_hash) continue;
    if (!byTool.has(call.tool)) byTool.set(call.tool, new Map());
    const resultMap = byTool.get(call.tool)!;
    if (!resultMap.has(call.result_hash)) resultMap.set(call.result_hash, new Set());
    resultMap.get(call.result_hash)!.add(call.args_hash);
  }

  for (const [tool, resultMap] of byTool) {
    for (const [, argSet] of resultMap) {
      if (argSet.size >= thresholds.same_result_critical) {
        return {
          failure_class: 'same_result_cycling',
          confidence: 1.0,
          trigger_count: argSet.size,
          trigger_tool: tool,
          trigger_pattern: `Tool "${tool}" returned identical results from ${argSet.size} different argument combinations.`,
          recommendation: `When "${tool}" consistently returns the same result despite different arguments, the target does not exist or is unreachable. Stop and ask the user.`,
        };
      }
      if (argSet.size >= thresholds.same_result_warning) {
        return {
          failure_class: 'same_result_cycling',
          confidence: 0.8,
          trigger_count: argSet.size,
          trigger_tool: tool,
          trigger_pattern: `Tool "${tool}" returned identical results from ${argSet.size} different inputs.`,
          recommendation: `Cycling through variations that all produce the same result wastes tokens. After 3 identical results, change strategy.`,
        };
      }
    }
  }
  return null;
}

// ─── Public classifier entry point ───────────────────────────────────────────

export interface ClassifyResult {
  result: ClassifierResult | null;
  /** true if the result came from rule-based detection (no LLM) */
  deterministic: boolean;
}

export function classifyToolCalls(
  calls: ToolCall[],
  config: ClassifierConfig,
): ClassifyResult {
  if (!config.stage1_enabled || calls.length === 0) {
    return { result: null, deterministic: true };
  }

  const t = config.thresholds;

  const exactRepeat = detectExactRepeat(calls, t);
  if (exactRepeat) return { result: exactRepeat, deterministic: true };

  const readOnly = detectReadOnlyStreak(calls, t);
  if (readOnly) return { result: readOnly, deterministic: true };

  const cycling = detectSameResultCycling(calls, t);
  if (cycling) return { result: cycling, deterministic: true };

  // Stage 2 (LLM) is deferred to v0.2 — return null for now
  return { result: null, deterministic: true };
}

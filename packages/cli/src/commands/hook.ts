/**
 * `evolvr hook` — called by Claude Code / Codex settings.json hooks.
 *
 * Usage (in settings.json):
 *   PreToolUse:  evolvr hook --event pre-tool  --task $TASK_ID --tool $TOOL_NAME --args-hash $ARGS_HASH
 *   PostToolUse: evolvr hook --event post-tool --task $TASK_ID --tool $TOOL_NAME --args-hash $ARGS_HASH --result-hash $RESULT_HASH --latency $LATENCY_MS
 *   Stop:        evolvr hook --event stop       --task $TASK_ID --outcome $OUTCOME [--reflection "..."]
 */
import { Command } from 'commander';
import { buildEvolvr } from '../context.js';
import type { Outcome } from '@evolvr/core';

export function registerHook(program: Command): void {
  program
    .command('hook')
    .description('Record a hook event from a Claude Code / Codex hook script')
    .requiredOption('--event <type>', 'Event type: pre-tool | post-tool | stop | start')
    .option('--task <id>', 'Task (session) ID')
    .option('--agent <name>', 'Agent name (default: claude)', 'claude')
    .option('--intent <text>', 'Task intent (for --event start)')
    .option('--tool <name>', 'Tool name (for pre-tool / post-tool)')
    .option('--seq <n>', 'Tool call sequence number', '0')
    .option('--args-hash <hash>', 'SHA-256 hash of tool arguments')
    .option('--result-hash <hash>', 'SHA-256 hash of tool result')
    .option('--result-summary <text>', 'First 200 chars of result')
    .option('--latency <ms>', 'Tool latency in ms', '0')
    .option('--outcome <outcome>', 'Task outcome for --event stop')
    .option('--reflection <text>', 'Optional reflection for --event stop')
    .option('--token-cost <n>', 'Token cost for --event stop')
    .action(async (opts: {
      event: string;
      task?: string;
      agent: string;
      intent?: string;
      tool?: string;
      seq: string;
      argsHash?: string;
      resultHash?: string;
      resultSummary?: string;
      latency: string;
      outcome?: string;
      reflection?: string;
      tokenCost?: string;
    }) => {
      let evolvr;
      try {
        evolvr = await buildEvolvr();
      } catch {
        // Silently exit — hooks must not block the agent
        process.exit(0);
      }

      try {
        switch (opts.event) {
          case 'start': {
            if (!opts.intent) break;
            const task = await evolvr.startTask({
              id: opts.task,
              agent: opts.agent,
              intent: opts.intent,
              session_id: opts.task,
            });
            // Print task ID for the hook script to capture
            process.stdout.write(task.id + '\n');
            break;
          }

          case 'pre-tool':
            // Nothing to do yet; future: intent guard injection
            break;

          case 'post-tool': {
            if (!opts.task || !opts.tool) break;
            await evolvr.recordToolCall(opts.task, {
              seq: Number(opts.seq),
              tool: opts.tool,
              args_hash: opts.argsHash ?? '',
              result_hash: opts.resultHash ?? '',
              result_summary: opts.resultSummary ?? '',
              latency_ms: Number(opts.latency),
            });
            break;
          }

          case 'stop': {
            if (!opts.task) break;
            await evolvr.completeTask(opts.task, {
              outcome: (opts.outcome ?? 'success') as Outcome,
              reflection: opts.reflection,
              token_cost: opts.tokenCost ? Number(opts.tokenCost) : undefined,
            });
            break;
          }
        }
      } catch {
        // Hooks must be silent — never surface errors to the agent shell
      }

      await evolvr.close();
    });
}

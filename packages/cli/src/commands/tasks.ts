import { Command } from 'commander';
import { buildEvolvr } from '../context.js';
import type { AgentName } from '@evolvr/core';
import chalk from 'chalk';

export function registerTasks(program: Command): void {
  program
    .command('tasks')
    .description('List recent tasks in the journal')
    .option('--agent <name>', 'filter by agent name')
    .option('--outcome <outcome>', 'filter by outcome (success|failed|partial|loop_stopped)')
    .option('--limit <n>', 'number of tasks to show', '20')
    .option('--show-tool-calls', 'include tool call list for each task')
    .action(async (opts: {
      agent?: string;
      outcome?: string;
      limit: string;
      showToolCalls?: boolean;
    }) => {
      let evolvr;
      try {
        evolvr = await buildEvolvr();
      } catch {
        console.error(chalk.red('evolvr is not initialized. Run `evolvr init` first.'));
        process.exit(1);
      }

      const tasks = await evolvr.listTasks({
        agent: opts.agent as AgentName | undefined,
        outcome: opts.outcome,
        limit: Number(opts.limit),
      });

      if (tasks.length === 0) {
        console.log(chalk.dim('No tasks found.'));
        await evolvr.close();
        return;
      }

      console.log(chalk.bold(`\n${tasks.length} task(s)\n`));
      console.log(chalk.dim('─'.repeat(72)));

      for (const t of tasks) {
        const outcomeColor = t.outcome === 'success' ? chalk.green
          : t.outcome === 'failed' ? chalk.red
          : t.outcome === 'loop_stopped' ? chalk.magenta
          : t.outcome === 'partial' ? chalk.yellow
          : chalk.dim;

        const outcome = t.outcome ? outcomeColor(t.outcome) : chalk.dim('running');
        const dur = t.duration_ms != null ? chalk.dim(` ${(t.duration_ms / 1000).toFixed(1)}s`) : '';

        console.log(`${chalk.bold(t.id)} ${chalk.dim(t.agent)}${dur}`);
        console.log(`  ${outcome}${t.failure_class ? chalk.dim(` [${t.failure_class}]`) : ''}`);
        console.log(`  ${t.intent.slice(0, 80)}`);
        if (t.reflection) {
          console.log(`  ${chalk.italic(chalk.dim(t.reflection.slice(0, 100)))}`);
        }
        console.log(`  ${chalk.dim(t.started_at)}`);

        if (opts.showToolCalls) {
          const calls = await evolvr.getToolCallsForTask(t.id);
          if (calls.length > 0) {
            console.log(`  ${chalk.bold('Tool calls:')} (${calls.length})`);
            for (const c of calls) {
              const rep = c.repeated ? chalk.yellow(' [repeat]') : '';
              const loop = c.was_loop_trigger ? chalk.red(' [loop!]') : '';
              console.log(`    ${String(c.seq).padStart(3)}  ${c.tool}${rep}${loop}`);
            }
          }
        }
        console.log(chalk.dim('─'.repeat(72)));
      }

      await evolvr.close();
    });
}

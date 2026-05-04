import { Command } from 'commander';
import { buildEvolvr } from '../context.js';
import chalk from 'chalk';

export function registerStatus(program: Command): void {
  program
    .command('status')
    .description('Show journal stats and recent activity')
    .action(async () => {
      let evolvr;
      try {
        evolvr = await buildEvolvr();
      } catch {
        console.error(chalk.red('evolvr is not initialized. Run `evolvr init` first.'));
        process.exit(1);
      }

      const stats = await evolvr.stats();
      const recentTasks = await evolvr.listTasks({ limit: 5 });

      console.log(chalk.bold('\nevolvr status\n'));
      console.log(chalk.dim('─'.repeat(40)));

      // Tasks
      console.log(chalk.bold('Tasks'));
      console.log(`  Total:    ${stats.total_tasks}`);
      console.log(`  Success:  ${chalk.green(stats.success_tasks)}`);
      console.log(`  Failed:   ${chalk.red(stats.failed_tasks)}`);
      const successRate = stats.total_tasks > 0
        ? ((stats.success_tasks / stats.total_tasks) * 100).toFixed(1)
        : '—';
      console.log(`  Rate:     ${successRate}%`);

      // Agents
      if (Object.keys(stats.agents).length > 0) {
        console.log('');
        console.log(chalk.bold('By agent'));
        for (const [agent, count] of Object.entries(stats.agents)) {
          console.log(`  ${agent.padEnd(12)} ${count}`);
        }
      }

      // Lessons
      console.log('');
      console.log(chalk.bold('Lessons'));
      console.log(`  Learned:  ${chalk.cyan(stats.total_lessons)}`);
      console.log(`  Pending:  ${stats.pending_lessons}`);

      // Recent tasks
      if (recentTasks.length > 0) {
        console.log('');
        console.log(chalk.bold('Recent tasks'));
        for (const t of recentTasks) {
          const outcomeColor = t.outcome === 'success' ? chalk.green
            : t.outcome === 'failed' || t.outcome === 'loop_stopped' ? chalk.red
            : chalk.yellow;
          const outcome = t.outcome ? outcomeColor(t.outcome.padEnd(12)) : chalk.dim('in progress ');
          const intent = t.intent.length > 50 ? t.intent.slice(0, 47) + '…' : t.intent;
          console.log(`  ${outcome} ${chalk.dim(t.agent.padEnd(10))} ${intent}`);
        }
      }

      console.log('');
      await evolvr.close();
    });
}

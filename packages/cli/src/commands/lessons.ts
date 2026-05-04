import { Command } from 'commander';
import { buildEvolvr } from '../context.js';
import type { AgentName, FailureClass } from '@evolvr/core';
import chalk from 'chalk';

export function registerLessons(program: Command): void {
  program
    .command('lessons')
    .description('List lessons learned from past failures')
    .option('--agent <name>', 'filter by agent name')
    .option('--class <class>', 'filter by failure class')
    .option('--min-confidence <n>', 'minimum confidence threshold', '0.0')
    .option('--promote', 'print a block ready to paste into AGENTS.md')
    .action(async (opts: {
      agent?: string;
      class?: string;
      minConfidence: string;
      promote?: boolean;
    }) => {
      let evolvr;
      try {
        evolvr = await buildEvolvr();
      } catch {
        console.error(chalk.red('evolvr is not initialized. Run `evolvr init` first.'));
        process.exit(1);
      }

      const lessons = await evolvr.getLessons({
        agent: opts.agent as AgentName | undefined,
        failure_class: opts.class as FailureClass | undefined,
        min_confidence: Number(opts.minConfidence),
        limit: 50,
      });

      if (lessons.length === 0) {
        console.log(chalk.dim('No lessons found. Run some tasks first.'));
        await evolvr.close();
        return;
      }

      if (opts.promote) {
        // Emit an AGENTS.md block
        console.log('## evolvr: Learned Behaviors\n');
        console.log('The following patterns were detected from past failures. Avoid them.\n');
        for (const l of lessons) {
          console.log(`### ${l.failure_class} (confidence: ${(l.confidence * 100).toFixed(0)}%)`);
          console.log(`**Pattern:** ${l.trigger_pattern}`);
          console.log(`**Recommendation:** ${l.recommendation}\n`);
        }
        await evolvr.close();
        return;
      }

      console.log(chalk.bold(`\n${lessons.length} lesson(s)\n`));
      console.log(chalk.dim('─'.repeat(72)));

      for (const l of lessons) {
        const confColor = l.confidence >= 0.8 ? chalk.green
          : l.confidence >= 0.6 ? chalk.yellow
          : chalk.red;
        const conf = confColor(`${(l.confidence * 100).toFixed(0)}%`);
        const agents = l.agent_scope.join(', ');
        const promoted = l.promoted_to_agents_md ? chalk.green(' [promoted]') : '';

        console.log(`${chalk.bold(l.failure_class)}${promoted}  ${conf} confidence  evidence: ${l.evidence_count}`);
        console.log(`  Agents: ${chalk.dim(agents)}`);
        console.log(`  Pattern: ${l.trigger_pattern}`);
        console.log(chalk.cyan(`  Fix:     ${l.recommendation}`));
        console.log(`  ${chalk.dim(`Last seen: ${l.last_seen_at}`)}`);
        console.log(chalk.dim('─'.repeat(72)));
      }

      await evolvr.close();
    });
}

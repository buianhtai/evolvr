import { Command } from 'commander';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '@evolvr/core';
import { buildEvolvr } from '../context.js';
import chalk from 'chalk';

export function registerInit(program: Command): void {
  program
    .command('init')
    .description('Initialize evolvr in the current project')
    .option('--storage <type>', 'storage backend: sqlite or postgres', 'sqlite')
    .option('--postgres-url <url>', 'PostgreSQL connection string (if --storage=postgres)')
    .action(async (opts: { storage: string; postgresUrl?: string }) => {
      const cwd = process.cwd();
      const evolvrDir = join(cwd, '.evolvr');

      if (existsSync(evolvrDir)) {
        console.log(chalk.yellow('evolvr is already initialized in this directory.'));
        console.log(chalk.dim('Run `evolvr status` to check the current state.'));
        return;
      }

      mkdirSync(evolvrDir, { recursive: true });

      const config = {
        ...DEFAULT_CONFIG,
        storage: opts.storage as 'sqlite' | 'postgres',
        ...(opts.postgresUrl ? { postgres_url: opts.postgresUrl } : {}),
      };
      writeFileSync(join(evolvrDir, 'config.json'), JSON.stringify(config, null, 2));

      // Add .evolvr/evolvr.db to .gitignore
      const gitignorePath = join(cwd, '.gitignore');
      const gitignoreEntry = '\n# evolvr\n.evolvr/evolvr.db\n';
      if (existsSync(gitignorePath)) {
        const { readFileSync, appendFileSync } = await import('node:fs');
        const content = readFileSync(gitignorePath, 'utf-8');
        if (!content.includes('.evolvr/evolvr.db')) {
          appendFileSync(gitignorePath, gitignoreEntry);
        }
      } else {
        writeFileSync(gitignorePath, gitignoreEntry.trimStart());
      }

      // Run migrations to create DB schema
      const evolvr = await buildEvolvr(cwd);
      await evolvr.close();

      console.log(chalk.green('✓') + ' evolvr initialized');
      console.log(chalk.dim(`  config: ${join(evolvrDir, 'config.json')}`));
      if (opts.storage === 'sqlite') {
        console.log(chalk.dim(`  db:     ${join(evolvrDir, 'evolvr.db')}`));
      }
      console.log('');
      console.log('Next steps:');
      console.log(chalk.cyan('  evolvr status') + '   — check the journal');
      console.log(chalk.cyan('  evolvr lessons') + '  — list learned behaviors');
    });
}

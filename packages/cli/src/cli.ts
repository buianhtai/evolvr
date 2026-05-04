import { Command } from 'commander';
import { registerInit } from './commands/init.js';
import { registerStatus } from './commands/status.js';
import { registerTasks } from './commands/tasks.js';
import { registerLessons } from './commands/lessons.js';
import { registerHook } from './commands/hook.js';

const program = new Command();

program
  .name('evolvr')
  .description('Self-evolving agent memory — track failures, surface lessons')
  .version('0.1.0');

registerInit(program);
registerStatus(program);
registerTasks(program);
registerLessons(program);
registerHook(program);

program.parse();

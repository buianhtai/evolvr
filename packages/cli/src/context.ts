/**
 * Resolve project root and build an Evolvr instance from config.
 * Used by every CLI command.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  Evolvr,
  loadConfig,
  defaultDbPath,
  createSqliteAdapter,
  createPostgresAdapter,
} from '@evolvr/core';

export async function buildEvolvr(cwd?: string): Promise<Evolvr> {
  const root = findProjectRoot(cwd ?? process.cwd());
  const config = loadConfig(root);

  let adapter;
  if (config.storage === 'postgres' && config.postgres_url) {
    adapter = createPostgresAdapter(config.postgres_url);
  } else {
    const dbPath = config.sqlite_path ?? defaultDbPath(root);
    adapter = createSqliteAdapter(dbPath);
  }

  const evolvr = new Evolvr(adapter, config);
  await evolvr.init();
  return evolvr;
}

function findProjectRoot(cwd: string): string {
  // 1. Walk up looking for an existing .evolvr directory (takes priority)
  let dir = resolve(cwd);
  while (true) {
    if (existsSync(join(dir, '.evolvr'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break; // reached fs root
    dir = parent;
  }

  // 2. Walk up again looking for package.json (project root heuristic)
  dir = resolve(cwd);
  while (true) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  // 3. Fall back to $HOME so global hooks always write to ~/.evolvr
  return process.env.HOME ?? cwd;
}

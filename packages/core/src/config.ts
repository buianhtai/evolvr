import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { EvolvrConfig } from './types.js';
import { DEFAULT_CONFIG } from './types.js';

export function loadConfig(projectRoot: string): EvolvrConfig {
  const configPath = join(projectRoot, '.evolvr', 'config.json');
  if (!existsSync(configPath)) return DEFAULT_CONFIG;

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<EvolvrConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      classifier: {
        ...DEFAULT_CONFIG.classifier,
        ...(parsed.classifier ?? {}),
        thresholds: {
          ...DEFAULT_CONFIG.classifier.thresholds,
          ...(parsed.classifier?.thresholds ?? {}),
        },
      },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function defaultDbPath(projectRoot: string): string {
  return join(projectRoot, '.evolvr', 'evolvr.db');
}

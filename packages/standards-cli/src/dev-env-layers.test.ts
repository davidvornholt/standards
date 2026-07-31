import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planDevEnvChanges } from './dev-env';

const EMPTY_EXPANSION = ['$', '{:-}'].join('');

const buildConsumer = (): string => {
  const consumer = mkdtempSync(join(tmpdir(), 'dev-env-layers-'));
  spawnSync('git', ['init', '--quiet', consumer]);
  writeFileSync(join(consumer, '.gitignore'), '.env.local\n');
  mkdirSync(join(consumer, 'apps/web'), { recursive: true });
  writeFileSync(join(consumer, 'apps/web/package.json'), '{"name":"web"}\n');
  return consumer;
};

const cleanup = (consumer: string): void =>
  rmSync(consumer, { recursive: true, force: true });

describe('dev env layered plan', () => {
  it('renders composed values with a header naming every source', () => {
    const consumer = buildConsumer();
    try {
      const plan = planDevEnvChanges(consumer, {
        config: { raw: { apps: { web: { PORT: '3000' } } } },
        secrets: { apps: { web: { AUTH_SECRET: 'shared' } } },
        local: { raw: { apps: { web: { PORT: '3100' } } } },
      });

      expect(plan.problems).toEqual([]);
      const content = plan.writes[0]?.content ?? '';
      expect(content).toContain(
        '# Sources: config/dev.yaml + secrets/dev.yaml + config/dev.local.yaml (apps.web)',
      );
      expect(content).toContain(`PORT=${EMPTY_EXPANSION}3100#`);
      expect(content).toContain(`AUTH_SECRET=${EMPTY_EXPANSION}shared#`);
    } finally {
      cleanup(consumer);
    }
  });

  it('plans a workspace declared only in tracked configuration', () => {
    const consumer = buildConsumer();
    try {
      const plan = planDevEnvChanges(consumer, {
        config: { raw: { apps: { web: { PORT: '3000' } } } },
        secrets: {},
        local: null,
      });

      expect(plan.problems).toEqual([]);
      expect(plan.writes.map((write) => write.rel)).toEqual([
        'apps/web/.env.local',
      ]);
      expect(plan.writes[0]?.content).toContain(
        '# Sources: config/dev.yaml (apps.web)',
      );
    } finally {
      cleanup(consumer);
    }
  });

  it('names every declaring source for a missing workspace', () => {
    const consumer = buildConsumer();
    try {
      const plan = planDevEnvChanges(consumer, {
        config: { raw: { apps: { ghost: { PORT: '1' } } } },
        secrets: { apps: { ghost: { AUTH_SECRET: 's' } } },
        local: null,
      });

      expect(plan.problems).toEqual([
        'config/dev.yaml + secrets/dev.yaml defines apps.ghost, but apps/ghost/package.json does not exist',
      ]);
      expect(plan.writes).toEqual([]);
    } finally {
      cleanup(consumer);
    }
  });

  it('treats a comment-only layer as an empty document', () => {
    const consumer = buildConsumer();
    try {
      const plan = planDevEnvChanges(consumer, {
        config: { raw: {} },
        secrets: { apps: { web: { AUTH_SECRET: 'shared' } } },
        local: { raw: {} },
      });

      expect(plan.problems).toEqual([]);
      expect(plan.writes.map((write) => write.rel)).toEqual([
        'apps/web/.env.local',
      ]);
    } finally {
      cleanup(consumer);
    }
  });
});

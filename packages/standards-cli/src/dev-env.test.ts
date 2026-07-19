import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planDevEnvWrites } from './dev-env';

const INVALID_WORKSPACE_COUNT = 4;

const buildConsumer = (options?: {
  readonly gitignore?: string | null;
}): string => {
  const consumer = mkdtempSync(join(tmpdir(), 'dev-env-'));
  spawnSync('git', ['init', '--quiet', consumer]);
  const gitignore = options?.gitignore;
  if (gitignore !== null) {
    writeFileSync(join(consumer, '.gitignore'), gitignore ?? '.env.local\n');
  }
  mkdirSync(join(consumer, 'apps/web'), { recursive: true });
  writeFileSync(join(consumer, 'apps/web/package.json'), '{"name":"web"}\n');
  return consumer;
};

const cleanup = (consumer: string): void =>
  rmSync(consumer, { recursive: true, force: true });

describe('dev env plan', () => {
  it('plans one gitignored .env.local per declared workspace', () => {
    const consumer = buildConsumer();
    try {
      const plan = planDevEnvWrites(consumer, {
        apps: { web: { AUTH_SECRET: 'dev-secret' } },
      });

      expect(plan.problems).toEqual([]);
      expect(plan.writes.map((write) => write.rel)).toEqual([
        'apps/web/.env.local',
      ]);
      expect(plan.writes[0]?.content).toContain('AUTH_SECRET="dev-secret"');
    } finally {
      cleanup(consumer);
    }
  });

  it('gathers missing-workspace and document problems together', () => {
    const consumer = buildConsumer();
    try {
      const plan = planDevEnvWrites(consumer, {
        apps: { web: { OK: 'yes' }, ghost: { OK: 'yes' } },
        infra: { host: {} },
      });

      expect(plan.problems).toEqual([
        'secrets/dev.yaml top-level key "infra" must be "apps" or "packages"',
        'secrets/dev.yaml defines apps.ghost, but apps/ghost/package.json does not exist',
      ]);
      expect(plan.writes.map((write) => write.rel)).toEqual([
        'apps/web/.env.local',
      ]);
    } finally {
      cleanup(consumer);
    }
  });

  it('refuses a target git would track', () => {
    const consumer = buildConsumer({ gitignore: 'node_modules/\n' });
    try {
      const plan = planDevEnvWrites(consumer, {
        apps: { web: { OK: 'yes' } },
      });

      expect(plan.writes).toEqual([]);
      expect(plan.problems).toEqual([
        'apps/web/.env.local is not gitignored; ignore it before generating dev env files',
      ]);
    } finally {
      cleanup(consumer);
    }
  });

  it('fails closed outside a git checkout', () => {
    const consumer = mkdtempSync(join(tmpdir(), 'dev-env-nogit-'));
    try {
      mkdirSync(join(consumer, 'apps/web'), { recursive: true });
      writeFileSync(join(consumer, 'apps/web/package.json'), '{}\n');

      const plan = planDevEnvWrites(consumer, {
        apps: { web: { OK: 'yes' } },
      });

      expect(plan.writes).toEqual([]);
      expect(plan.problems).toEqual([
        'cannot verify apps/web/.env.local is gitignored (git check-ignore exited 128)',
      ]);
    } finally {
      cleanup(consumer);
    }
  });

  it('does not plan path-like workspace names', () => {
    const consumer = buildConsumer();
    try {
      const plan = planDevEnvWrites(consumer, {
        apps: {
          '..': { OK: 'yes' },
          'nested/name': { OK: 'yes' },
          '/absolute': { OK: 'yes' },
          'with space': { OK: 'yes' },
        },
      });

      expect(plan.writes).toEqual([]);
      expect(plan.problems).toHaveLength(INVALID_WORKSPACE_COUNT);
    } finally {
      cleanup(consumer);
    }
  });
});

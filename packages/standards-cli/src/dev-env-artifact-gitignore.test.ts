import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEV_ENV_GITIGNORE, initializeDevEnvGit } from './dev-env-test-support';
import { applyDevEnvChanges } from './dev-env-transaction';

const TEMP_IGNORE_PROBLEM =
  /apps\/web\/\.env\.local\.standards-[0-9a-f-]+\.tmp is not gitignored/u;
const BACKUP_IGNORE_PROBLEM =
  /apps\/web\/\.env\.local\.standards-[0-9a-f-]+\.bak is not gitignored/u;

const artifactNames = (consumer: string): ReadonlyArray<string> =>
  ['apps/web', 'packages/db'].flatMap((workspace) =>
    readdirSync(join(consumer, workspace))
      .filter((name) => name.includes('.standards-'))
      .map((name) => `${workspace}/${name}`),
  );

const gitArtifactLines = (consumer: string, args: ReadonlyArray<string>) =>
  execFileSync('git', ['-C', consumer, ...args], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.includes('.standards-'));

const fixture = (gitignore: string): string => {
  const consumer = mkdtempSync(join(tmpdir(), 'dev-env-artifacts-'));
  initializeDevEnvGit(consumer);
  writeFileSync(join(consumer, '.gitignore'), gitignore);
  for (const workspace of ['apps/web', 'packages/db']) {
    mkdirSync(join(consumer, workspace), { recursive: true });
  }
  return consumer;
};

describe('dev env transaction artifact ignoredness', () => {
  it('rejects its actual random temp and backup paths before staging', async () => {
    const consumer = fixture('.env.local\n');
    try {
      let staged = false;
      const result = await applyDevEnvChanges(
        consumer,
        [{ rel: 'apps/web/.env.local', content: 'SECRET=new\n' }],
        {
          beforeStage: () => {
            staged = true;
          },
        },
      );

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(staged).toBe(false);
      expect(result.problems).toHaveLength(2);
      expect(result.problems[0]).toMatch(TEMP_IGNORE_PROBLEM);
      expect(result.problems[1]).toMatch(BACKUP_IGNORE_PROBLEM);
      expect(artifactNames(consumer)).toEqual([]);
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  it('keeps staged artifacts for absent and replaced files out of git', async () => {
    const consumer = fixture(DEV_ENV_GITIGNORE);
    try {
      writeFileSync(join(consumer, 'packages/db/.env.local'), 'SECRET=old\n');
      let visibleStatus: ReadonlyArray<string> = [];
      let visibleIndex: ReadonlyArray<string> = [];

      const result = await applyDevEnvChanges(
        consumer,
        [
          { rel: 'apps/web/.env.local', content: 'SECRET=web\n' },
          { rel: 'packages/db/.env.local', content: 'SECRET=db\n' },
        ],
        {
          beforeCommit: (index) => {
            if (index === 0) {
              visibleStatus = gitArtifactLines(consumer, [
                'status',
                '--porcelain',
                '--untracked-files=all',
              ]);
              execFileSync('git', ['-C', consumer, 'add', '-A']);
              visibleIndex = gitArtifactLines(consumer, [
                'diff',
                '--cached',
                '--name-only',
              ]);
            }
          },
        },
      );

      expect(result).toEqual({ ok: true, warnings: [] });
      expect(visibleStatus).toEqual([]);
      expect(visibleIndex).toEqual([]);
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });
});

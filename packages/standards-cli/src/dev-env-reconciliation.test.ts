import { describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEV_ENV_GENERATED_HEADER } from './dev-env-dotenv';
import { planDevEnvRemovals } from './dev-env-reconciliation';

const workspace = (
  consumer: string,
  rel: string,
  content: string,
  packageJson = true,
): void => {
  mkdirSync(join(consumer, rel), { recursive: true });
  if (packageJson) {
    writeFileSync(join(consumer, rel, 'package.json'), '{}\n');
  }
  writeFileSync(join(consumer, rel, '.env.local'), content);
};

describe('dev env stale workspace discovery', () => {
  it('removes only exact-header files in direct package workspaces', () => {
    const consumer = mkdtempSync(join(tmpdir(), 'dev-env-removals-'));
    try {
      workspace(
        consumer,
        'apps/owned',
        `${DEV_ENV_GENERATED_HEADER}\nSECRET=old\n`,
      );
      workspace(consumer, 'apps/hand-owned', 'SECRET=mine\n');
      workspace(
        consumer,
        'apps/edited-header',
        `${DEV_ENV_GENERATED_HEADER} edited\nSECRET=mine\n`,
      );
      workspace(
        consumer,
        'packages/crlf-header',
        `${DEV_ENV_GENERATED_HEADER}\r\nSECRET=mine\r\n`,
      );
      workspace(
        consumer,
        'packages/no-package',
        `${DEV_ENV_GENERATED_HEADER}\nSECRET=old\n`,
        false,
      );
      workspace(
        consumer,
        'other/outside',
        `${DEV_ENV_GENERATED_HEADER}\nSECRET=old\n`,
      );

      expect(planDevEnvRemovals(consumer, [])).toEqual({
        removals: [{ rel: 'apps/owned/.env.local' }],
        problems: [],
      });
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  it('does not enter symlinked workspaces or follow env symlinks', () => {
    const consumer = mkdtempSync(join(tmpdir(), 'dev-env-removal-links-'));
    const external = mkdtempSync(join(tmpdir(), 'dev-env-removal-external-'));
    try {
      workspace(
        external,
        'linked',
        `${DEV_ENV_GENERATED_HEADER}\nSECRET=outside\n`,
      );
      mkdirSync(join(consumer, 'apps/direct'), { recursive: true });
      writeFileSync(join(consumer, 'apps/direct/package.json'), '{}\n');
      symlinkSync(
        join(external, 'linked/.env.local'),
        join(consumer, 'apps/direct/.env.local'),
      );
      mkdirSync(join(consumer, 'packages'), { recursive: true });
      symlinkSync(join(external, 'linked'), join(consumer, 'packages/linked'));

      expect(planDevEnvRemovals(consumer, [])).toEqual({
        removals: [],
        problems: [],
      });
    } finally {
      rmSync(consumer, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });

  it('does not enter a symlinked workspace group', () => {
    const consumer = mkdtempSync(join(tmpdir(), 'dev-env-removal-group-link-'));
    const external = mkdtempSync(join(tmpdir(), 'dev-env-removal-group-'));
    try {
      workspace(
        external,
        'outside',
        `${DEV_ENV_GENERATED_HEADER}\nSECRET=outside\n`,
      );
      symlinkSync(external, join(consumer, 'apps'));

      expect(planDevEnvRemovals(consumer, [])).toEqual({
        removals: [],
        problems: [],
      });
    } finally {
      rmSync(consumer, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });
});

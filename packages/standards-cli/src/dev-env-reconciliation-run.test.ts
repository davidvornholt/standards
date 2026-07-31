import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { runDevEnv } from './dev-env';
import { DEV_ENV_GENERATED_HEADER } from './dev-env-dotenv';
import { initializeDevEnvGit } from './dev-env-test-support';

const EXECUTABLE_MODE = 0o755;
const originalPath = process.env.PATH;
const roots: Array<string> = [];

const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'dev-env-reconcile-run-'));
  roots.push(root);
  const consumer = join(root, 'consumer');
  mkdirSync(consumer);
  initializeDevEnvGit(consumer);
  for (const workspace of ['apps/web', 'packages/db']) {
    mkdirSync(join(consumer, workspace), { recursive: true });
    writeFileSync(join(consumer, workspace, 'package.json'), '{}\n');
  }
  mkdirSync(join(consumer, 'config'));
  mkdirSync(join(consumer, 'secrets'));
  writeFileSync(
    join(consumer, 'config/dev.yaml'),
    'apps:\n  web:\n    PORT: "3000"\n',
  );
  writeFileSync(join(consumer, 'secrets/dev.yaml'), 'encrypted\n');
  writeFileSync(
    join(consumer, 'packages/db/.env.local'),
    `${DEV_ENV_GENERATED_HEADER}\nOLD_SECRET=remove-me\n`,
  );
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const sops = join(bin, 'sops');
  writeFileSync(sops, '#!/bin/sh\nprintf "{}"\n');
  chmodSync(sops, EXECUTABLE_MODE);
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
  return consumer;
};

afterEach(() => {
  mock.restore();
  process.env.PATH = originalPath;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('dev env reconciliation command', () => {
  it('writes current targets, removes stale generated targets, and reports both', async () => {
    const consumer = fixture();
    const log = spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await runDevEnv(consumer)).toBe(true);

    expect(
      readFileSync(join(consumer, 'apps/web/.env.local'), 'utf8'),
    ).toContain('3000#');
    expect(existsSync(join(consumer, 'packages/db/.env.local'))).toBe(false);
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('wrote apps/web/.env.local');
    expect(output).toContain('removed packages/db/.env.local');
  });
});

// A core consumer's check holds its CI secrets declaration and sops-secret
// action callers to the rules the Bun payload's structure gate applies,
// because the core payload ships the workflows that read secrets/ci.yaml and
// the sops-secret action.

import { afterEach, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import {
  cleanupTmpDirs,
  mkTmp,
  type RunResult,
  runProcess,
  SOPS_ACTION,
  write,
  writeSyncManifest,
} from './cli-test-support';
import { writeCiSecretsPair } from './structure-test-support';

afterEach(cleanupTmpDirs);

const ENGINE = join(import.meta.dir, 'cli.ts');
const ACTION = '.github/actions/sops-secret/action.yml';

const run = (consumer: string, args: ReadonlyArray<string>): RunResult =>
  runProcess('bun', consumer, [ENGINE, ...args], process.env);

const coreConsumer = (): string => {
  const up = mkTmp('core-secrets-up-');
  writeSyncManifest(up, up, [], ['sync-standards.json', ACTION]);
  mkdirSync(dirname(join(up, ACTION)), { recursive: true });
  copyFileSync(SOPS_ACTION, join(up, ACTION));
  const consumer = mkTmp('core-secrets-cons-');
  execFileSync('git', ['init', '--quiet', consumer]);
  write(consumer, 'sync-standards.local.json', '{ "payload": "core" }\n');
  writeCiSecretsPair(consumer);
  expect(run(consumer, ['init', '--from', up, '--dir', consumer]).status).toBe(
    0,
  );
  return consumer;
};

it('passes check with a well-formed CI secrets pair', () => {
  const consumer = coreConsumer();
  const result = run(consumer, ['check', '--dir', consumer]);
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('standards secrets:');
});

it('fails check on an example that no longer mirrors secrets/ci.yaml', () => {
  const consumer = coreConsumer();
  write(consumer, 'secrets/ci.example.yaml', 'ci: {}\n');

  const result = run(consumer, ['check', '--dir', consumer]);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    'secrets/ci.example.yaml: missing key "ci.broker_app.client_id"',
  );
});

it('fails check on a missing secrets/ci.yaml while automatic sync is on', () => {
  const consumer = coreConsumer();
  rmSync(join(consumer, 'secrets/ci.yaml'));

  const result = run(consumer, ['check', '--dir', consumer]);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('secrets/ci.yaml: must exist');
});

it('fails check on a sops-secret caller that passes a retired input', () => {
  const consumer = coreConsumer();
  write(
    consumer,
    '.github/workflows/deploy.yml',
    'jobs:\n  deploy:\n    steps:\n      - uses: ./.github/actions/sops-secret\n        with: { env-name: DEPLOY_TOKEN }\n',
  );

  const result = run(consumer, ['check', '--dir', consumer]);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    '.github/workflows/deploy.yml still passes env-name',
  );
});

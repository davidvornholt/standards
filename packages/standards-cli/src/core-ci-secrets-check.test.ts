import { afterEach, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
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
  const init = run(consumer, ['init', '--from', up, '--dir', consumer]);
  if (init.status !== 0) {
    throw new Error(`init failed: ${init.stderr}`);
  }
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

it('refuses to seed through a symlinked secrets directory', () => {
  const up = mkTmp('core-secrets-up-');
  writeSyncManifest(up, up, [], ['sync-standards.json']);
  const manifest = JSON.parse(
    readFileSync(join(up, 'sync-standards.json'), 'utf8'),
  ) as { payloads: { core: { seeds: Array<string> } } };
  manifest.payloads.core.seeds = [
    '.github/settings.local.json',
    'secrets/ci.example.yaml',
  ];
  write(up, 'sync-standards.json', JSON.stringify(manifest));
  write(up, 'template/.github/settings.local.json', '{}\n');
  write(up, 'template/secrets/ci.example.yaml', 'ci: {}\n');
  const consumer = mkTmp('core-secrets-cons-');
  execFileSync('git', ['init', '--quiet', consumer]);
  write(consumer, 'sync-standards.local.json', '{ "payload": "core" }\n');
  const shared = mkTmp('core-secrets-shared-');
  symlinkSync(shared, join(consumer, 'secrets'));

  const result = run(consumer, ['init', '--from', up, '--dir', consumer]);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    'secrets/ci.example.yaml is below the symlink secrets',
  );
  expect(readdirSync(shared)).toEqual([]);
  expect(existsSync(join(consumer, '.github/settings.local.json'))).toBe(false);
});

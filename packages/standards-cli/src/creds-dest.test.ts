import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listSecretsTargets,
  parseDestination,
  resolveContext,
  resolveTargetRel,
} from './creds-dest';
import { setSopsValue } from './creds-sops';

const dirs: Array<string> = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const configureRepo = (consumer: string): void => {
  spawnSync('git', ['init', '--quiet'], { cwd: consumer });
  spawnSync(
    'git',
    ['remote', 'add', 'origin', 'git@github.com:owner/repository.git'],
    { cwd: consumer },
  );
};

describe('credential destinations', () => {
  it('accepts safe target and dotted-key segments', () => {
    expect(parseDestination('ci:ci.cloudflare_token')).toEqual({
      target: 'ci',
      key: 'ci.cloudflare_token',
    });
    expect(parseDestination('prod-1:github.deploy_app')).toEqual({
      target: 'prod-1',
      key: 'github.deploy_app',
    });
  });

  it('rejects traversal, absolute-like, empty, reserved, and unsafe inputs', () => {
    const invalid = [
      '',
      ':ci.token',
      'ci:',
      '../../outside/victim:github.app',
      '../victim:github.app',
      '/absolute:github.app',
      String.raw`C:\victim:github.app`,
      String.raw`ci\victim:github.app`,
      'ci/victim:github.app',
      '.hidden:github.app',
      'ci:.github',
      'ci:github.',
      'ci:github..app',
      'ci:github/app',
      String.raw`ci:github\app`,
      'ci:sops.value',
      'ci:github.__proto__',
      'ci:github app',
    ];
    for (const raw of invalid) {
      expect(parseDestination(raw)).toBeNull();
    }
  });

  it('cannot resolve or modify a traversal target outside the consumer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'creds-dest-'));
    dirs.push(root);
    const consumer = join(root, 'consumer');
    const outside = join(root, 'outside');
    mkdirSync(join(consumer, 'secrets'), { recursive: true });
    mkdirSync(outside);
    const victim = join(outside, 'victim.yaml');
    writeFileSync(victim, 'github:\n  app: old\nsops: {}\n');

    expect(resolveTargetRel(consumer, '../outside/victim')).toBeNull();
    expect(
      await resolveContext(consumer, '../outside/victim:github.deploy_app'),
    ).toBeNull();
    expect(readFileSync(victim, 'utf8')).toBe(
      'github:\n  app: old\nsops: {}\n',
    );
  });

  it('rejects a flat target symlink before command or SOPS mutation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'creds-dest-link-'));
    dirs.push(root);
    const consumer = join(root, 'consumer');
    const outside = join(root, 'outside.yaml');
    mkdirSync(join(consumer, 'secrets'), { recursive: true });
    configureRepo(consumer);
    writeFileSync(outside, 'ci:\n  token: outside\nsops: {}\n');
    symlinkSync(outside, join(consumer, 'secrets', 'ci.yaml'));

    expect(resolveTargetRel(consumer, 'ci')).toBeNull();
    expect(await resolveContext(consumer, 'ci:ci.token')).toBeNull();
    expect(
      setSopsValue(consumer, 'secrets/ci.yaml', 'ci.token', 'new'),
    ).toEqual({
      ok: false,
      problem: 'unsafe encrypted secrets target secrets/ci.yaml',
    });
    expect(readFileSync(outside, 'utf8')).toContain('token: outside');
  });

  it('rejects a symlinked host directory and omits it from listing', () => {
    const root = mkdtempSync(join(tmpdir(), 'creds-host-link-'));
    dirs.push(root);
    const consumer = join(root, 'consumer');
    const outsideHost = join(root, 'outside-host');
    mkdirSync(join(consumer, 'infra', 'hosts'), { recursive: true });
    mkdirSync(outsideHost);
    writeFileSync(
      join(outsideHost, 'secrets.yaml'),
      'ci:\n  token: outside\nsops: {}\n',
    );
    symlinkSync(outsideHost, join(consumer, 'infra', 'hosts', 'prod'), 'dir');

    expect(resolveTargetRel(consumer, 'prod')).toBeNull();
    expect(listSecretsTargets(consumer)).toEqual([]);
  });
});

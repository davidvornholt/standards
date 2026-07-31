import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { runDevEnv } from './dev-env';

const EXECUTABLE_MODE = 0o755;
const UNREADABLE_MODE = 0o000;
const originalPath = process.env.PATH;
const roots: Array<string> = [];

type SecretFailure = 'decrypt' | 'json';
type LocalFailure = 'dangling' | 'malformed' | 'unreadable';

const sopsScript = (failure: SecretFailure | null) => {
  if (failure === 'decrypt') {
    return '#!/bin/sh\nprintf "decrypt failed" >&2\nexit 23\n';
  }
  if (failure === 'json') {
    return '#!/bin/sh\nprintf "not-json"\n';
  }
  return '#!/bin/sh\nprintf "{}"\n';
};

const setup = (
  secretFailure: SecretFailure | null,
  localFailure: LocalFailure,
): { readonly consumer: string; readonly destination: string } => {
  const root = mkdtempSync(join(tmpdir(), 'dev-env-validation-'));
  roots.push(root);
  const consumer = join(root, 'consumer');
  execFileSync('git', ['init', '--quiet', consumer]);
  mkdirSync(join(consumer, 'apps/web'), { recursive: true });
  mkdirSync(join(consumer, 'config'), { recursive: true });
  mkdirSync(join(consumer, 'secrets'), { recursive: true });
  writeFileSync(join(consumer, '.gitignore'), '.env.local\n');
  writeFileSync(join(consumer, 'apps/web/package.json'), '{"name":"web"}\n');
  writeFileSync(join(consumer, 'config/dev.yaml'), 'apps: [unterminated\n');
  writeFileSync(join(consumer, 'secrets/dev.yaml'), 'encrypted\n');

  const local = join(consumer, 'config/dev.local.yaml');
  if (localFailure === 'dangling') {
    symlinkSync('missing-dev-local.yaml', local);
  } else {
    writeFileSync(
      local,
      localFailure === 'malformed' ? 'apps: [unterminated\n' : 'apps: {}\n',
    );
    if (localFailure === 'unreadable') {
      chmodSync(local, UNREADABLE_MODE);
    }
  }

  const destination = join(consumer, 'apps/web/.env.local');
  writeFileSync(destination, 'existing-value\n');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const sops = join(bin, 'sops');
  writeFileSync(sops, sopsScript(secretFailure));
  chmodSync(sops, EXECUTABLE_MODE);
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
  return { consumer, destination };
};

afterEach(() => {
  mock.restore();
  process.env.PATH = originalPath;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('dev env input validation aggregation', () => {
  it('reports a missing secrets layer with both malformed plain layers', async () => {
    const fixture = setup(null, 'malformed');
    rmSync(join(fixture.consumer, 'secrets/dev.yaml'));
    const error = spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await runDevEnv(fixture.consumer)).toBe(false);

    const reported = error.mock.calls.flat().join('\n');
    expect(reported).toContain('config/dev.yaml must contain valid YAML');
    expect(reported).toContain('secrets/dev.yaml not found');
    expect(reported).toContain('config/dev.local.yaml must contain valid YAML');
    expect(reported).toContain(
      'config/dev.local.yaml is not gitignored; ignore it before generating dev env files',
    );
    expect(readFileSync(fixture.destination, 'utf8')).toBe('existing-value\n');
  });

  it('does not plan destinations after an input acquisition failure', async () => {
    const fixture = setup(null, 'malformed');
    writeFileSync(
      join(fixture.consumer, 'config/dev.yaml'),
      'apps:\n  ghost:\n    PORT: "3000"\n',
    );
    const error = spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await runDevEnv(fixture.consumer)).toBe(false);

    const reported = error.mock.calls.flat().join('\n');
    expect(reported).toContain('config/dev.local.yaml must contain valid YAML');
    expect(reported).not.toContain('apps/ghost/package.json');
    expect(readFileSync(fixture.destination, 'utf8')).toBe('existing-value\n');
  });

  for (const localFailure of ['malformed', 'unreadable', 'dangling'] as const) {
    it(`checks git ignoredness for ${localFailure} local input`, async () => {
      const fixture = setup(null, localFailure);
      const error = spyOn(console, 'error').mockImplementation(() => undefined);

      expect(await runDevEnv(fixture.consumer)).toBe(false);

      const reported = error.mock.calls.flat().join('\n');
      expect(reported).toContain(
        localFailure === 'malformed'
          ? 'config/dev.local.yaml must contain valid YAML'
          : 'could not read config/dev.local.yaml',
      );
      expect(reported).toContain(
        'config/dev.local.yaml is not gitignored; ignore it before generating dev env files',
      );
      expect(readFileSync(fixture.destination, 'utf8')).toBe(
        'existing-value\n',
      );
    });
  }

  for (const secretFailure of ['decrypt', 'json'] as const) {
    for (const localFailure of [
      'malformed',
      'unreadable',
      'dangling',
    ] as const) {
      it(`reports ${secretFailure} and ${localFailure} local failures together`, async () => {
        const fixture = setup(secretFailure, localFailure);
        const error = spyOn(console, 'error').mockImplementation(
          () => undefined,
        );
        const log = spyOn(console, 'log').mockImplementation(() => undefined);

        expect(await runDevEnv(fixture.consumer)).toBe(false);

        const reported = error.mock.calls.flat().join('\n');
        expect(reported).toContain(
          secretFailure === 'decrypt'
            ? 'could not decrypt secrets/dev.yaml: decrypt failed'
            : 'could not parse decrypted secrets/dev.yaml as JSON',
        );
        expect(reported).toContain('config/dev.yaml must contain valid YAML');
        expect(reported).toContain(
          localFailure === 'malformed'
            ? 'config/dev.local.yaml must contain valid YAML'
            : 'could not read config/dev.local.yaml',
        );
        expect(reported).toContain(
          'config/dev.local.yaml is not gitignored; ignore it before generating dev env files',
        );
        expect(readFileSync(fixture.destination, 'utf8')).toBe(
          'existing-value\n',
        );
        expect(log).not.toHaveBeenCalled();
      });
    }
  }
});

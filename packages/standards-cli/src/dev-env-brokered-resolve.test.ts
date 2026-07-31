import { afterEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { resolveBrokeredReferences } from './dev-env-brokered-resolve';
import type { ComposedDevEnvTarget } from './dev-env-compose';

const EXECUTABLE_MODE = 0o755;
const originalPath = process.env.PATH;
const roots: Array<string> = [];

// The fake sops answers per requested file so one consumer can hold several
// brokered targets; a counter file proves each target is decrypted once.
const fixture = (documents: Readonly<Record<string, unknown>>): string => {
  const root = mkdtempSync(join(tmpdir(), 'dev-env-brokered-'));
  roots.push(root);
  const consumer = join(root, 'consumer');
  mkdirSync(join(consumer, 'secrets'), { recursive: true });
  const responses: Array<string> = [];
  for (const [rel, value] of Object.entries(documents)) {
    writeFileSync(join(consumer, rel), 'encrypted\n');
    responses.push(
      `    ${JSON.stringify(rel)}) printf '%s' ${JSON.stringify(JSON.stringify(value))} ;;`,
    );
  }
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'sops'),
    [
      '#!/bin/sh',
      `echo "$4" >> ${JSON.stringify(join(root, 'calls.log'))}`,
      'case "$4" in',
      ...responses,
      '    *) echo "unexpected file $4" >&2; exit 1 ;;',
      'esac',
    ].join('\n'),
  );
  chmodSync(join(bin, 'sops'), EXECUTABLE_MODE);
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
  return consumer;
};

afterEach(() => {
  process.env.PATH = originalPath;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const target = (env: ComposedDevEnvTarget['env']): ComposedDevEnvTarget => ({
  group: 'apps',
  workspace: 'web',
  env,
  sources: ['config/dev.yaml'],
});

const pairReference = (part: 'access_key_id' | 'secret_access_key') => ({
  brokeredS3: 'r2-dev',
  key: 'r2.dev_rw',
  part,
});

describe('brokered S3 pair resolution', () => {
  it('resolves both pair parts and passes literals through', () => {
    const consumer = fixture({
      'secrets/r2-dev.yaml': {
        r2: { dev_rw: { access_key_id: 'AKID', secret_access_key: 'SECRET' } },
      },
    });

    const resolved = resolveBrokeredReferences(consumer, [
      target({
        PORT: '3000',
        S3_ACCESS_KEY_ID: pairReference('access_key_id'),
        S3_SECRET_ACCESS_KEY: pairReference('secret_access_key'),
      }),
    ]);

    expect(resolved.problems).toEqual([]);
    expect(resolved.targets[0]?.env).toEqual({
      PORT: '3000',
      S3_ACCESS_KEY_ID: 'AKID',
      S3_SECRET_ACCESS_KEY: 'SECRET',
    });
  });

  it('reports a missing secrets target with the minting command', () => {
    const consumer = fixture({});

    const resolved = resolveBrokeredReferences(consumer, [
      target({ S3_ACCESS_KEY_ID: pairReference('access_key_id') }),
    ]);

    expect(resolved.problems).toEqual([
      'apps.web.S3_ACCESS_KEY_ID reference to secrets target "r2-dev": secrets target "r2-dev" does not exist; create it and mint the pair with `bun standards creds add cloudflare --s3`',
    ]);
    expect(resolved.targets[0]?.env).toEqual({});
  });

  it('reports a target without the referenced pair key or part', () => {
    const consumer = fixture({
      'secrets/r2-dev.yaml': { r2: { other: { access_key_id: 'AKID' } } },
    });

    const resolved = resolveBrokeredReferences(consumer, [
      target({
        S3_ACCESS_KEY_ID: pairReference('access_key_id'),
        S3_SECRET_ACCESS_KEY: {
          brokeredS3: 'r2-dev',
          key: 'r2.other',
          part: 'secret_access_key',
        },
      }),
    ]);

    expect(resolved.problems).toEqual([
      'apps.web.S3_ACCESS_KEY_ID reference to secrets target "r2-dev": has no key "r2.dev_rw"; mint the pair with `bun standards creds add cloudflare --s3 --dest r2-dev:r2.dev_rw`',
      'apps.web.S3_SECRET_ACCESS_KEY reference to secrets target "r2-dev": key "r2.other" does not hold a brokered S3 pair with "secret_access_key"',
    ]);
  });
});

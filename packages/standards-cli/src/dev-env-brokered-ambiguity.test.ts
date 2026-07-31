import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { runDevEnv } from './dev-env';
import {
  brokeredFixture,
  sopsCalls,
} from './dev-env-brokered-resolve-test-support';
import { initializeDevEnvGit } from './dev-env-test-support';

const originalPath = process.env.PATH;
const DEV_RW = 'dev_rw';
const ACCESS_KEY_ID = 'access_key_id';
const SECRET_ACCESS_KEY = 'secret_access_key';
let root = '';

afterEach(() => {
  process.env.PATH = originalPath;
  if (root.length > 0) {
    rmSync(root, { recursive: true, force: true });
    root = '';
  }
});

describe('brokered S3 target identity', () => {
  it('rejects a duplicate flat and host target before referenced-target decryption', async () => {
    const fixture = brokeredFixture({
      'secrets/dev.yaml': {
        brokeredReferences: ['r2-dev:r2.dev_rw'],
      },
      'secrets/r2-dev.yaml': {
        r2: {
          [DEV_RW]: {
            [ACCESS_KEY_ID]: 'FLAT_AKID',
            [SECRET_ACCESS_KEY]: 'FLAT_SECRET',
          },
        },
      },
      'infra/hosts/r2-dev/secrets.yaml': {
        r2: {
          [DEV_RW]: {
            [ACCESS_KEY_ID]: 'HOST_AKID',
            [SECRET_ACCESS_KEY]: 'HOST_SECRET',
          },
        },
      },
    });
    const { bin, consumer, root: fixtureRoot } = fixture;
    root = fixtureRoot;
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    mkdirSync(join(consumer, 'apps/web'), { recursive: true });
    mkdirSync(join(consumer, 'config'));
    writeFileSync(join(consumer, 'apps/web/package.json'), '{"name":"web"}\n');
    writeFileSync(
      join(consumer, 'config/dev.yaml'),
      'apps:\n  web:\n    S3_ACCESS_KEY_ID:\n      brokeredS3: r2-dev\n      key: r2.dev_rw\n      part: access_key_id\n',
    );
    initializeDevEnvGit(consumer);
    const destination = join(consumer, 'apps/web/.env.local');
    writeFileSync(destination, 'UNCHANGED=true\n');
    const error = spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await runDevEnv(consumer)).toBe(false);
    expect(readFileSync(destination, 'utf8')).toBe('UNCHANGED=true\n');
    expect(sopsCalls(consumer)).toEqual(['secrets/dev.yaml']);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        'secrets target "r2-dev" is ambiguous because both secrets/r2-dev.yaml and infra/hosts/r2-dev/secrets.yaml exist',
      ),
    );
  });
});

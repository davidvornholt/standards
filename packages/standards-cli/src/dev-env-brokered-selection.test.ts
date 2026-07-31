import { afterEach, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import process from 'node:process';
import { resolveBrokeredReferences } from './dev-env-brokered-resolve';
import {
  brokeredFixture,
  pairReference,
  sopsCalls,
} from './dev-env-brokered-resolve-test-support';
import { composeDevEnv } from './dev-env-compose';
import { type DevEnvLayerKind, parseDevEnvDocument } from './dev-env-document';

const originalPath = process.env.PATH;
const fixtureRoots: Array<string> = [];
const ACCESS_KEY_ENV = 'S3_ACCESS_KEY_ID';
const PAIR_KEY = 'dev_rw';
const ACCESS_KEY_PART = 'access_key_id';
const SECRET_KEY_PART = 'secret_access_key';

afterEach(() => {
  process.env.PATH = originalPath;
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const layer = (source: string, raw: unknown, kind: DevEnvLayerKind) => ({
  source,
  document: parseDevEnvDocument(raw, source, kind),
});

it('does not decrypt a configuration reference overridden by a local literal', () => {
  const fixture = brokeredFixture({
    'secrets/r2-dev.yaml': {
      r2: {
        [PAIR_KEY]: {
          [ACCESS_KEY_PART]: 'AKID',
          [SECRET_KEY_PART]: 'SECRET',
        },
      },
    },
  });
  fixtureRoots.push(fixture.root);
  process.env.PATH = `${fixture.bin}:${originalPath ?? ''}`;
  const composed = composeDevEnv(
    layer(
      'config/dev.yaml',
      {
        apps: { web: { [ACCESS_KEY_ENV]: pairReference('access_key_id') } },
      },
      'configuration',
    ),
    layer(
      'secrets/dev.yaml',
      { brokeredReferences: ['r2-dev:r2.dev_rw'] },
      'secrets',
    ),
    layer(
      'config/dev.local.yaml',
      { apps: { web: { [ACCESS_KEY_ENV]: 'LOCAL' } } },
      'configuration',
    ),
  );

  const resolved = resolveBrokeredReferences(
    fixture.consumer,
    composed.targets,
    composed.brokeredReferences,
  );

  expect(composed.problems).toEqual([]);
  expect(resolved.problems).toEqual([]);
  expect(resolved.targets[0]?.env).toEqual({ [ACCESS_KEY_ENV]: 'LOCAL' });
  expect(sopsCalls(fixture.consumer)).toEqual([]);
});

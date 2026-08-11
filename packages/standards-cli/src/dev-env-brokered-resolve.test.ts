import { afterEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import process from 'node:process';
import { resolveBrokeredReferences } from './dev-env-brokered-resolve';
import {
  ALLOWED_PAIR,
  brokeredFixture,
  pairReference,
  sopsCalls,
  brokeredTarget as target,
} from './dev-env-brokered-resolve-test-support';

const MALFORMED_PAIR_PART = 42;
const originalPath = process.env.PATH;
const roots: Array<string> = [];
const fixture = (documents: Readonly<Record<string, unknown>>): string => {
  const created = brokeredFixture(documents);
  roots.push(created.root);
  process.env.PATH = `${created.bin}:${originalPath ?? ''}`;
  return created.consumer;
};

afterEach(() => {
  process.env.PATH = originalPath;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('brokered S3 pair resolution', () => {
  it('resolves both pair parts and passes literals through', () => {
    const consumer = fixture({
      'secrets/r2-dev.yaml': {
        r2: { dev_rw: { access_key_id: 'AKID', secret_access_key: 'SECRET' } },
      },
    });

    const resolved = resolveBrokeredReferences(
      consumer,
      [
        target({
          PORT: '3000',
          S3_ACCESS_KEY_ID: pairReference('access_key_id'),
          S3_SECRET_ACCESS_KEY: pairReference('secret_access_key'),
        }),
      ],
      ALLOWED_PAIR,
    );

    expect(resolved.problems).toEqual([]);
    expect(resolved.targets[0]?.env).toEqual({
      PORT: '3000',
      S3_ACCESS_KEY_ID: 'AKID',
      S3_SECRET_ACCESS_KEY: 'SECRET',
    });
    expect(sopsCalls(consumer)).toEqual(['secrets/r2-dev.yaml']);
  });

  it('resolves an authorized pair from a contained host target', () => {
    const consumer = fixture({
      'infra/hosts/dev-1/secrets.yaml': {
        r2: {
          dev_rw: {
            access_key_id: 'HOST_AKID',
            secret_access_key: 'HOST_SECRET',
          },
        },
      },
    });

    const resolved = resolveBrokeredReferences(
      consumer,
      [
        target({
          S3_ACCESS_KEY_ID: {
            ...pairReference('access_key_id'),
            brokeredS3: 'dev-1',
          },
        }),
      ],
      new Set(['dev-1:r2.dev_rw']),
    );

    expect(resolved.problems).toEqual([]);
    expect(resolved.targets[0]?.env).toEqual({
      S3_ACCESS_KEY_ID: 'HOST_AKID',
    });
    expect(sopsCalls(consumer)).toEqual(['infra/hosts/dev-1/secrets.yaml']);
  });

  it('rejects an unauthorized pair before decrypting its target', () => {
    const consumer = fixture({
      'secrets/r2-dev.yaml': {
        r2: {
          dev_rw: {
            access_key_id: 'MUST_NOT_LEAK_AKID',
            secret_access_key: 'MUST_NOT_LEAK_SECRET',
          },
        },
      },
    });

    const resolved = resolveBrokeredReferences(
      consumer,
      [target({ S3_ACCESS_KEY_ID: pairReference('access_key_id') })],
      new Set(),
    );

    expect(resolved.problems).toEqual([
      'apps.web.S3_ACCESS_KEY_ID reference to secrets target "r2-dev": unauthorized brokered S3 pair; add "r2-dev:r2.dev_rw" to the encrypted secrets/dev.yaml brokeredReferences allowlist',
    ]);
    expect(resolved.problems.join('\n')).not.toContain('MUST_NOT_LEAK');
    expect(sopsCalls(consumer)).toEqual([]);
  });
});

describe('brokered S3 pair failures', () => {
  it('reports a missing secrets target with the minting command', () => {
    const consumer = fixture({});

    const resolved = resolveBrokeredReferences(
      consumer,
      [target({ S3_ACCESS_KEY_ID: pairReference('access_key_id') })],
      ALLOWED_PAIR,
    );

    expect(resolved.problems).toEqual([
      'apps.web.S3_ACCESS_KEY_ID reference to secrets target "r2-dev": secrets target "r2-dev" does not exist; create it and mint the pair with `bun standards creds add cloudflare --s3`',
    ]);
    expect(resolved.targets[0]?.env).toEqual({});
  });

  it('reports a target without the referenced pair key', () => {
    const consumer = fixture({
      'secrets/r2-dev.yaml': {
        r2: {
          other: { access_key_id: 'AKID', secret_access_key: 'SECRET' },
        },
      },
    });

    const resolved = resolveBrokeredReferences(
      consumer,
      [target({ S3_ACCESS_KEY_ID: pairReference('access_key_id') })],
      ALLOWED_PAIR,
    );

    expect(resolved.problems).toEqual([
      'apps.web.S3_ACCESS_KEY_ID reference to secrets target "r2-dev": has no key "r2.dev_rw"; mint the pair with `bun standards creds add cloudflare --s3 --dest r2-dev:r2.dev_rw`',
    ]);
  });

  it.each([
    ['missing secret sibling', 'access_key_id', { access_key_id: 'AKID' }],
    [
      'malformed secret sibling',
      'access_key_id',
      { access_key_id: 'AKID', secret_access_key: MALFORMED_PAIR_PART },
    ],
    [
      'missing access sibling',
      'secret_access_key',
      { secret_access_key: 'SECRET' },
    ],
    [
      'malformed access sibling',
      'secret_access_key',
      { access_key_id: MALFORMED_PAIR_PART, secret_access_key: 'SECRET' },
    ],
  ] as const)(
    'rejects a broker destination with a %s',
    (_label, part, pair) => {
      const consumer = fixture({
        'secrets/r2-dev.yaml': { r2: { dev_rw: pair } },
      });

      const resolved = resolveBrokeredReferences(
        consumer,
        [target({ VALUE: pairReference(part) })],
        ALLOWED_PAIR,
      );

      expect(resolved.problems).toEqual([
        'apps.web.VALUE reference to secrets target "r2-dev": key "r2.dev_rw" does not hold a complete brokered S3 pair; both "access_key_id" and "secret_access_key" must be strings',
      ]);
      expect(resolved.targets[0]?.env).toEqual({});
    },
  );
});

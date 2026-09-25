import { afterEach, expect, it, spyOn } from 'bun:test';
import { sleep } from 'bun';
import {
  ACCOUNT_A,
  cleanupCredsAdd,
  initializeConsumer,
  response,
} from './creds-add-test-support';
import { renewPlannedToken } from './creds-plan-renew';
import { revokeStoredDuplicate } from './creds-revoke-duplicate';
// biome-ignore lint/performance/noNamespaceImport: intercept only SOPS I/O while exercising both real operations and their shared lock.
import * as sops from './creds-sops';
// biome-ignore lint/performance/noNamespaceImport: intercept verification without replacing credential lifecycle behavior.
import * as values from './creds-sops-value';
// biome-ignore lint/performance/noNamespaceImport: provide an in-memory encrypted destination for the concurrency regression.
import * as exec from './sops-exec';

const ID_LENGTH = 32;
const OLD = 'b'.repeat(ID_LENGTH);
const REPLACEMENT = 'c'.repeat(ID_LENGTH);
const NAME = 'standards/davidvornholt/example/ci/ci.token';
const CONTENDER_WAIT_MS = 75;
const account = { accountId: ACCOUNT_A, token: 'synthetic-bootstrap' };
const duplicate = (id: string) => ({
  id,
  name: NAME,
  status: 'active',
  expiresOn: null,
  issuedOn: null,
  policies: [],
  condition: { supported: true as const, value: null },
});
afterEach(cleanupCredsAdd);

it('keeps a concurrently renewed credential active when duplicate retirement observes its new provider ID', async () => {
  const consumer = initializeConsumer([ACCOUNT_A]);
  let stored = OLD;
  const deleted: Array<string> = [];
  const minted = Promise.withResolvers<void>();
  const resumeMint = Promise.withResolvers<void>();
  spyOn(sops, 'setSopsValues').mockImplementation((_cwd, _rel, writes) => {
    stored = writes[0]?.value ?? '';
    return { ok: true };
  });
  spyOn(values, 'verifySopsStoredValue').mockImplementation(
    (_cwd, _rel, _key, expected) => ({
      ok: true,
      matches: stored === expected,
    }),
  );
  spyOn(exec, 'decryptSopsJson').mockImplementation(() => ({
    ok: true,
    value: { ci: { token: stored } },
  }));
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (init?.method === 'POST') {
      minted.resolve();
      await resumeMint.promise;
      return response({ id: REPLACEMENT, value: REPLACEMENT });
    }
    if (init?.method === 'DELETE') {
      const id = url.split('/').at(-1) ?? '';
      deleted.push(id);
      return response({ id });
    }
    const id = new Headers(init?.headers)
      .get('authorization')
      ?.slice('Bearer '.length);
    return response({
      id,
      status: deleted.includes(id ?? '') ? 'disabled' : 'active',
    });
  }) as typeof fetch;
  const renewal = renewPlannedToken(consumer, account, {
    kind: 'renew',
    accountId: ACCOUNT_A,
    tokenId: OLD,
    name: NAME,
    target: 'ci',
    key: 'ci.token',
    format: 'bearer',
    policies: [],
    condition: null,
    replacementExpiresOn: '2027-01-01T00:00:00Z',
    reason: 'expiring',
  });
  await minted.promise;
  const retirement = revokeStoredDuplicate({
    consumer,
    account,
    tokenId: REPLACEMENT,
    ref: { repo: 'davidvornholt/example', target: 'ci', key: 'ci.token' },
    duplicates: [duplicate(OLD), duplicate(REPLACEMENT)],
  });
  try {
    await sleep(CONTENDER_WAIT_MS);
    expect(deleted).toEqual([]);
  } finally {
    resumeMint.resolve();
    await Promise.all([renewal, retirement]);
  }
  expect((await renewal).failure).toBeNull();
  expect(await retirement).toContain('currently stored');
  expect(stored).toBe(REPLACEMENT);
  expect(deleted).toEqual([OLD]);
});

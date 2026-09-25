import { afterEach, expect, it, spyOn } from 'bun:test';
import { sleep } from 'bun';
import { runCredsAddCloudflare } from './creds-add';
import {
  ACCOUNT_A,
  cleanupCredsAdd,
  initializeConsumer,
  pageInfo,
  response,
} from './creds-add-test-support';
// biome-ignore lint/performance/noNamespaceImport: mock only encrypted storage I/O, preserving real collision and transaction behavior.
import * as sops from './creds-sops';
// biome-ignore lint/performance/noNamespaceImport: verify the test's in-memory stored credential without running SOPS.
import * as values from './creds-sops-value';

const CONTENDER_WAIT_MS = 75;
const NAME = 'standards/davidvornholt/example/ci/ci.token';
const options = {
  dest: 'ci:ci.token',
  permissions: 'Workers Scripts Write',
  account: ACCOUNT_A,
  ttlDays: 90,
  bucket: undefined,
  zone: undefined,
  s3: false,
};
afterEach(cleanupCredsAdd);

it('rechecks creation collisions under the same lock before a simultaneous add can mint', async () => {
  const consumer = initializeConsumer([ACCOUNT_A]);
  const listing = Promise.withResolvers<void>();
  const resumeListing = Promise.withResolvers<void>();
  const minted: Array<string> = [];
  let stored = '';
  let listings = 0;
  spyOn(console, 'log').mockImplementation(() => undefined);
  const error = spyOn(console, 'error').mockImplementation(() => undefined);
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
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (String(input).includes('permission_groups')) {
      return response([
        {
          id: 'pg',
          name: 'Workers Scripts Write',
          scopes: ['com.cloudflare.api.account'],
        },
      ]);
    }
    if (init?.method === 'POST') {
      const id = `created-${minted.length}`;
      minted.push(id);
      return response({ id, value: id });
    }
    const snapshot = minted.map((id) => ({ id, name: NAME, status: 'active' }));
    listings += 1;
    if (listings === 1) {
      listing.resolve();
      await resumeListing.promise;
    }
    return response(snapshot, pageInfo(snapshot.length, snapshot.length));
  }) as typeof fetch;
  const first = runCredsAddCloudflare(consumer, options);
  await listing.promise;
  const second = runCredsAddCloudflare(consumer, options);
  try {
    await sleep(CONTENDER_WAIT_MS);
    expect(listings).toBe(1);
    expect(minted).toEqual([]);
  } finally {
    resumeListing.resolve();
    await Promise.all([first, second]);
  }
  expect(await first).toBe(true);
  expect(await second).toBe(false);
  expect(minted).toEqual(['created-0']);
  expect(stored).toBe('created-0');
  expect(error).toHaveBeenCalledWith(
    expect.stringContaining('managed Cloudflare token already exists'),
  );
});

import { afterEach, expect, it, mock, spyOn } from 'bun:test';
import { join } from 'node:path';
import process from 'node:process';
import { cleanupTmpDirs, mkTmp } from './cli-test-support';
// biome-ignore lint/performance/noNamespaceImport: provider lookup interception keeps the login test offline.
import * as api from './creds-github-app-api';
import { refreshOwnedGithubStore } from './creds-github-apps';
import { runCredsLoginGithub } from './creds-login-github';
// biome-ignore lint/performance/noNamespaceImport: read interception reproduces a replacement after the update lock is released.
import * as store from './creds-store';

const originalBroker = process.env.STANDARDS_BROKER_FILE;
const app = (owner: string, appId: number): store.GithubBrokerApp => ({
  owner,
  appId,
  slug: `app-${appId}`,
  htmlUrl: `https://github.com/apps/app-${appId}`,
  clientId: `Iv1.${appId}`,
  privateKey: `key-${appId}`,
});
afterEach(() => {
  mock.restore();
  cleanupTmpDirs();
  if (originalBroker === undefined) {
    delete process.env.STANDARDS_BROKER_FILE;
  } else {
    process.env.STANDARDS_BROKER_FILE = originalBroker;
  }
});

it('returns the authenticated committed snapshot without an unlocked replacement read', async () => {
  const path = join(mkTmp('owner-snapshot-'), 'broker.yaml');
  await store.updateBrokerStore(path, () => ({
    github: [app('old', 1)],
    cloudflare: [],
  }));
  const read = store.readBrokerStore;
  let reads = 0;
  spyOn(store, 'readBrokerStore').mockImplementation((requested) => {
    reads += 1;
    return reads > 2
      ? Promise.resolve({ github: [app('new', 2)], cloudflare: [] })
      : read(requested);
  });
  const refreshed = await refreshOwnedGithubStore(path, () =>
    Promise.resolve({ ok: true, value: 'new' }),
  );
  expect(refreshed).toEqual({
    ok: true,
    value: { github: [app('new', 1)], cloudflare: [] },
  });
});

it('organization login proceeds with a healthy target despite an unavailable unrelated App', async () => {
  const path = join(mkTmp('owner-login-'), 'broker.yaml');
  process.env.STANDARDS_BROKER_FILE = path;
  await store.updateBrokerStore(path, () => ({
    github: [app('target', 1), app('unrelated', 2)],
    cloudflare: [],
  }));
  const lookedUp: Array<string | null> = [];
  spyOn(api, 'resolveGithubAppOwner').mockImplementation((candidate) => {
    lookedUp.push(candidate.owner);
    return Promise.resolve(
      candidate.owner === 'target'
        ? { ok: true, value: 'target' }
        : { ok: false, problem: 'unavailable' },
    );
  });
  spyOn(console, 'error').mockImplementation(() => undefined);
  let reachedLogin = false;
  await runCredsLoginGithub(
    { name: 'fixture-app', org: 'target' },
    {
      waitForCode: () => {
        reachedLogin = true;
        return Promise.resolve('fixture');
      },
      convertManifestCode: () =>
        Promise.resolve({
          ok: false,
          problem: 'fixture stops before creating credentials',
        }),
      openInBrowser: () => undefined,
    },
  );
  expect(reachedLogin).toBe(true);
  expect(lookedUp).toEqual(['target']);
});

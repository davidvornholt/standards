import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { runCredsLoginGithub } from './creds-login-github';
import { type GithubBrokerApp, readBrokerStore } from './creds-store';
import { withBrokerLock } from './creds-store-lock';

const dirs: Array<string> = [];
const originalBroker = process.env.STANDARDS_BROKER_FILE;
const CONVERTED_APP_ID = 41;
const LOCK_ATTEMPT_MS = 25;
const PAST_DEFAULT_TIMEOUT_MS = 11_000;

const brokerPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'creds-login-live-lock-'));
  dirs.push(dir);
  const path = join(dir, 'broker.yaml');
  process.env.STANDARDS_BROKER_FILE = path;
  return path;
};

const convertedApp: GithubBrokerApp = {
  owner: 'example',
  appId: CONVERTED_APP_ID,
  slug: 'converted-app',
  htmlUrl: 'https://github.com/apps/converted-app',
  clientId: 'Iv1.converted',
  privateKey: 'one-time-private-key',
};

afterEach(() => {
  if (originalBroker === undefined) {
    delete process.env.STANDARDS_BROKER_FILE;
  } else {
    process.env.STANDARDS_BROKER_FILE = originalBroker;
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('GitHub App login with a live broker holder', () => {
  it('persists the converted App after an unbounded holder releases', async () => {
    const path = brokerPath();
    const holderStarted = Promise.withResolvers<void>();
    const holderRelease = Promise.withResolvers<void>();
    const holder = withBrokerLock(path, async () => {
      holderStarted.resolve();
      await holderRelease.promise;
    });
    await holderStarted.promise;
    const initialNow = Date.now();
    let deadlineInitialized = false;
    const clock = spyOn(Date, 'now').mockImplementation(() => {
      if (!deadlineInitialized) {
        deadlineInitialized = true;
        return initialNow;
      }
      return initialNow + PAST_DEFAULT_TIMEOUT_MS;
    });
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const login = runCredsLoginGithub(
        { name: undefined, org: 'example' },
        {
          waitForCode: () => Promise.resolve('converted'),
          convertManifestCode: () =>
            Promise.resolve({ ok: true, app: convertedApp }),
          openInBrowser: () => undefined,
        },
      );
      await new Promise((resolve) => setTimeout(resolve, LOCK_ATTEMPT_MS));

      expect(deadlineInitialized).toBe(true);
      expect((await readBrokerStore(path)).github).toEqual([]);
      holderRelease.resolve();
      await holder;
      expect(await login).toBe(true);
      expect((await readBrokerStore(path)).github).toEqual([convertedApp]);
    } finally {
      holderRelease.resolve();
      await holder;
      clock.mockRestore();
      log.mockRestore();
    }
  });
});

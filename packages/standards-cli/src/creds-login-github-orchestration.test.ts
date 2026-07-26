import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { runCredsLoginGithub } from './creds-login-github';
import {
  type ManifestConversion,
  resolveGithubAppName,
} from './creds-login-github-manifest';
import { type GithubBrokerApp, readBrokerStore } from './creds-store';

const dirs: Array<string> = [];
const originalBroker = process.env.STANDARDS_BROKER_FILE;
const LONGEST_DEFAULT_OWNER_LENGTH = 17;
const FIRST_TOO_LONG_DEFAULT_OWNER_LENGTH = 18;

const brokerPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'creds-login-github-'));
  dirs.push(dir);
  const path = join(dir, 'broker.yaml');
  process.env.STANDARDS_BROKER_FILE = path;
  return path;
};

const brokerApp = (owner: string, appId: number): GithubBrokerApp => ({
  owner,
  appId,
  slug: `app-${appId}`,
  htmlUrl: `https://github.com/apps/app-${appId}`,
  clientId: `Iv1.${appId}`,
  privateKey: `private-${appId}`,
});

const conversion = (owner: string, appId: number): ManifestConversion => ({
  ok: true,
  app: brokerApp(owner, appId),
});

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

describe('GitHub App login synchronization', () => {
  it('preserves the first key when two same-owner logins overlap', async () => {
    const path = brokerPath();
    const codes = [
      Promise.withResolvers<string>(),
      Promise.withResolvers<string>(),
    ] as const;
    let waiting = 0;
    let markBothWaiting = (): void => undefined;
    const bothWaiting = new Promise<void>((resolve) => {
      markBothWaiting = resolve;
    });
    const waitForCode = () => {
      const code = codes[waiting];
      waiting += 1;
      if (waiting === 2) {
        markBothWaiting();
      }
      if (code === undefined) {
        return Promise.reject(new Error('unexpected third login'));
      }
      return code.promise;
    };
    let conversions = 0;
    const convertManifestCode = () => {
      conversions += 1;
      return Promise.resolve(conversion('example', conversions));
    };
    const openInBrowser = () => undefined;
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    const log = spyOn(console, 'log').mockImplementation(() => undefined);

    const first = runCredsLoginGithub(
      { name: undefined, org: 'example' },
      { waitForCode, convertManifestCode, openInBrowser },
    );
    const second = runCredsLoginGithub(
      { name: undefined, org: 'example' },
      { waitForCode, convertManifestCode, openInBrowser },
    );
    await bothWaiting;
    codes[0].resolve('first');
    expect(await first).toBe(true);
    codes[1].resolve('second');

    expect(await second).toBe(false);
    expect((await readBrokerStore(path)).github).toEqual([
      brokerApp('example', 1),
    ]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('changed while this App was being created'),
    );
    log.mockRestore();
  });

  it('merges different owners when their logins overlap', async () => {
    const path = brokerPath();
    const codes = [
      Promise.withResolvers<string>(),
      Promise.withResolvers<string>(),
    ] as const;
    let waiting = 0;
    let markBothWaiting = (): void => undefined;
    const bothWaiting = new Promise<void>((resolve) => {
      markBothWaiting = resolve;
    });
    const waitForCode = () => {
      const code = codes[waiting];
      waiting += 1;
      if (waiting === 2) {
        markBothWaiting();
      }
      if (code === undefined) {
        return Promise.reject(new Error('unexpected third login'));
      }
      return code.promise;
    };
    const convertManifestCode = (code: string) =>
      Promise.resolve(
        code === 'created'
          ? conversion('first-owner', 1)
          : conversion('second-owner', 2),
      );
    let conversions = 0;
    const convertInOrder = () => {
      conversions += 1;
      return convertManifestCode(conversions === 1 ? 'created' : 'second');
    };
    const openInBrowser = () => undefined;
    const log = spyOn(console, 'log').mockImplementation(() => undefined);

    const first = runCredsLoginGithub(
      { name: 'first-app', org: 'first-owner' },
      { waitForCode, convertManifestCode: convertInOrder, openInBrowser },
    );
    const second = runCredsLoginGithub(
      { name: 'second-app', org: 'second-owner' },
      { waitForCode, convertManifestCode: convertInOrder, openInBrowser },
    );
    await bothWaiting;
    codes[0].resolve('created');
    expect(await first).toBe(true);
    codes[1].resolve('second');

    expect(await second).toBe(true);
    expect(
      (await readBrokerStore(path)).github.map(({ owner }) => owner),
    ).toEqual(['first-owner', 'second-owner']);
    log.mockRestore();
  });
});

describe('GitHub App default names', () => {
  it('accepts an organization owner at the 17-character boundary', () => {
    const owner = 'a'.repeat(LONGEST_DEFAULT_OWNER_LENGTH);
    expect(resolveGithubAppName(undefined, owner)).toEqual({
      ok: true,
      value: `standards-broker-${owner}`,
    });
  });

  it('requires an explicit shorter name for an 18-character owner', () => {
    const resolved = resolveGithubAppName(
      undefined,
      'a'.repeat(FIRST_TOO_LONG_DEFAULT_OWNER_LENGTH),
    );
    expect(resolved).toEqual({
      ok: false,
      problem: expect.stringContaining('--name'),
    });
  });
});

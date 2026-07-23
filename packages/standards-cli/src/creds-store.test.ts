import { afterEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type BrokerStore,
  EMPTY_BROKER_STORE,
  inspectBrokerFileMode,
  readBrokerStore,
  updateBrokerStore,
} from './creds-store';

const dirs: Array<string> = [];
const storePath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'creds-store-'));
  dirs.push(dir);
  return join(dir, 'nested', 'broker.yaml');
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ACCOUNT_ID_LENGTH = 32;
const LOCK_COMPETITION_MS = 10;

const APP = {
  appId: 42,
  slug: 'standards-broker',
  htmlUrl: 'https://github.com/apps/standards-broker',
  clientId: 'Iv1.abc',
  privateKey:
    '-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----\n',
};

const replaceStore = async (
  path: string,
  store: BrokerStore,
): Promise<void> => {
  await updateBrokerStore(path, () => store);
};

describe('broker store', () => {
  it('returns the empty store for a missing file', async () => {
    const path = storePath();
    expect(await readBrokerStore(path)).toEqual(EMPTY_BROKER_STORE);
    expect(inspectBrokerFileMode(path).exists).toBe(false);
  });

  it('round-trips github and cloudflare credentials with 0600 permissions', async () => {
    const path = storePath();
    const store = {
      github: APP,
      cloudflare: [
        { accountId: 'a'.repeat(ACCOUNT_ID_LENGTH), token: 'cfat_secret' },
      ],
    };
    await replaceStore(path, store);
    expect(inspectBrokerFileMode(path)).toEqual({
      exists: true,
      problem: null,
    });
    expect(await readBrokerStore(path)).toEqual(store);
  });

  it('tightens permissions when overwriting an existing broader file', async () => {
    const path = storePath();
    await replaceStore(path, EMPTY_BROKER_STORE);
    writeFileSync(path, 'github:\n', { mode: 0o644 });
    await replaceStore(path, { ...EMPTY_BROKER_STORE, github: APP });
    expect(inspectBrokerFileMode(path)).toEqual({
      exists: true,
      problem: null,
    });
  });

  it('syncs the parent directory only after the atomic rename', async () => {
    const target = storePath();
    mkdirSync(dirname(target), { recursive: true });
    const calls: Array<string> = [];
    await updateBrokerStore(
      target,
      () => EMPTY_BROKER_STORE,
      (parent) => {
        expect(existsSync(target)).toBe(true);
        calls.push(`sync:${parent}`);
        return Promise.resolve();
      },
    );
    expect(calls).toEqual([`sync:${dirname(target)}`]);
  });

  it('rejects a malformed github section with a login hint', async () => {
    const path = storePath();
    await replaceStore(path, EMPTY_BROKER_STORE);
    writeFileSync(path, 'github:\n  app_id: "not-a-number"\n');
    expect(readBrokerStore(path)).rejects.toThrow(
      'standards creds login github',
    );
  });

  it('rejects a malformed cloudflare entry with a login hint', async () => {
    const path = storePath();
    await replaceStore(path, EMPTY_BROKER_STORE);
    writeFileSync(path, 'cloudflare:\n  - account_id: abc\n');
    expect(readBrokerStore(path)).rejects.toThrow(
      'standards creds login cloudflare',
    );
  });

  it('serializes concurrent updates without losing either provider', async () => {
    const path = storePath();
    let releaseFirst = (): void => undefined;
    let markEntered = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const github = updateBrokerStore(path, async (store) => {
      markEntered();
      await release;
      return { ...store, github: APP };
    });
    await entered;
    const cloudflare = updateBrokerStore(path, (store) => ({
      ...store,
      cloudflare: [
        ...store.cloudflare,
        { accountId: 'a'.repeat(ACCOUNT_ID_LENGTH), token: 'cfat_secret' },
      ],
    }));
    await new Promise((resolve) => setTimeout(resolve, LOCK_COMPETITION_MS));
    releaseFirst();
    await Promise.all([github, cloudflare]);
    expect(await readBrokerStore(path)).toEqual({
      github: APP,
      cloudflare: [
        { accountId: 'a'.repeat(ACCOUNT_ID_LENGTH), token: 'cfat_secret' },
      ],
    });
  });

  it('leaves the prior atomic file intact when an update is interrupted', async () => {
    const path = storePath();
    await replaceStore(path, { ...EMPTY_BROKER_STORE, github: APP });
    await expect(
      updateBrokerStore(path, () => {
        throw new Error('simulated interruption');
      }),
    ).rejects.toThrow('simulated interruption');
    expect(await readBrokerStore(path)).toEqual({
      github: APP,
      cloudflare: [],
    });
    expect(readdirSync(join(path, '..'))).toEqual(['broker.yaml']);
  });
});

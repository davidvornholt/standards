import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMPTY_BROKER_STORE,
  inspectBrokerFileMode,
  readBrokerStore,
  writeBrokerStore,
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

const APP = {
  appId: 42,
  slug: 'standards-broker',
  htmlUrl: 'https://github.com/apps/standards-broker',
  clientId: 'Iv1.abc',
  privateKey:
    '-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----\n',
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
    await writeBrokerStore(path, store);
    expect(inspectBrokerFileMode(path)).toEqual({
      exists: true,
      problem: null,
    });
    expect(await readBrokerStore(path)).toEqual(store);
  });

  it('tightens permissions when overwriting an existing broader file', async () => {
    const path = storePath();
    await writeBrokerStore(path, EMPTY_BROKER_STORE);
    writeFileSync(path, 'github:\n', { mode: 0o644 });
    await writeBrokerStore(path, { ...EMPTY_BROKER_STORE, github: APP });
    expect(inspectBrokerFileMode(path)).toEqual({
      exists: true,
      problem: null,
    });
  });

  it('rejects a malformed github section with a login hint', async () => {
    const path = storePath();
    await writeBrokerStore(path, EMPTY_BROKER_STORE);
    writeFileSync(path, 'github:\n  app_id: "not-a-number"\n');
    expect(readBrokerStore(path)).rejects.toThrow(
      'standards creds login github',
    );
  });

  it('rejects a malformed cloudflare entry with a login hint', async () => {
    const path = storePath();
    await writeBrokerStore(path, EMPTY_BROKER_STORE);
    writeFileSync(path, 'cloudflare:\n  - account_id: abc\n');
    expect(readBrokerStore(path)).rejects.toThrow(
      'standards creds login cloudflare',
    );
  });
});

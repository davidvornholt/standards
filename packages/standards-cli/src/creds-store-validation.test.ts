import { afterEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CloudflareBrokerAccount,
  EMPTY_BROKER_STORE,
  readBrokerStore,
  updateBrokerStore,
} from './creds-store';

const ACCOUNT_ID_LENGTH = 32;
const BROADER_FILE_MODE = 0o640;
const VALID_ACCOUNT = 'a'.repeat(ACCOUNT_ID_LENGTH);
const dirs: Array<string> = [];

const storePath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'creds-store-validation-'));
  dirs.push(dir);
  return join(dir, 'broker.yaml');
};

const account = (
  accountId: string,
  token = 'cfat_secret',
): CloudflareBrokerAccount => ({ accountId, token });

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('broker store Cloudflare account validation', () => {
  it.each([
    ['uppercase', 'A'.repeat(ACCOUNT_ID_LENGTH)],
    ['wrong-length', 'a'.repeat(ACCOUNT_ID_LENGTH - 1)],
    ['non-hex', 'g'.repeat(ACCOUNT_ID_LENGTH)],
  ])('rejects a %s account ID during decode', async (_, accountId) => {
    const path = storePath();
    writeFileSync(
      path,
      `cloudflare:\n  - account_id: ${accountId}\n    token: cfat_secret\n`,
    );

    await expect(readBrokerStore(path)).rejects.toThrow(
      '32 lowercase hexadecimal characters',
    );
  });

  it.each([
    ['duplicate', [account(VALID_ACCOUNT), account(VALID_ACCOUNT)]],
    ['malformed', [account('not-an-account-id')]],
  ] as const)('rejects a %s post-update account list without replacing the store', async (_, accounts) => {
    const path = storePath();
    const initial = {
      ...EMPTY_BROKER_STORE,
      cloudflare: [account(VALID_ACCOUNT, 'original')],
    };
    await updateBrokerStore(path, () => initial);
    chmodSync(path, BROADER_FILE_MODE);
    const bytes = readFileSync(path);
    const { mode } = statSync(path);

    await expect(
      updateBrokerStore(path, (store) => ({
        ...store,
        cloudflare: accounts,
      })),
    ).rejects.toThrow();
    expect(readFileSync(path)).toEqual(bytes);
    const { mode: currentMode } = statSync(path);
    expect(currentMode).toBe(mode);
  });
});

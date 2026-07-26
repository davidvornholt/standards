import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  ACCOUNT_A,
  cleanupCredsAdd,
  initializeConsumer,
  pageInfo,
  response,
} from './creds-add-test-support';
import { runCredsCommand } from './creds-commands';

const ID_LENGTH = 32;
const BOOTSTRAP_ID = `f${'0'.repeat(ID_LENGTH - 1)}`;
const FOREIGN_ID = `a${'1'.repeat(ID_LENGTH - 1)}`;
const BROKERED_ID = `b${'2'.repeat(ID_LENGTH - 1)}`;
const MISSING_ID = `c${'3'.repeat(ID_LENGTH - 1)}`;

const stubAccount = (): Array<string> => {
  const requests: Array<string> = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    requests.push(`${method} ${url}`);
    if (url.endsWith('/verify')) {
      return Promise.resolve(response({ id: BOOTSTRAP_ID, status: 'active' }));
    }
    if (method === 'DELETE') {
      return Promise.resolve(response({ id: 'deleted' }));
    }
    const tokens = [
      { id: BOOTSTRAP_ID, name: 'standards-broker', status: 'active' },
      { id: FOREIGN_ID, name: 'dns-token-from-2023', status: 'active' },
      {
        id: BROKERED_ID,
        name: 'standards/davidvornholt/example/ci/ci.dns_token',
        status: 'active',
      },
    ];
    return Promise.resolve(
      response(tokens, pageInfo(tokens.length, tokens.length)),
    );
  }) as typeof fetch;
  return requests;
};

const deletes = (requests: ReadonlyArray<string>): ReadonlyArray<string> =>
  requests.filter((request) => request.startsWith('DELETE'));

afterEach(cleanupCredsAdd);

describe('creds revoke', () => {
  it('deletes a token the broker did not mint', async () => {
    initializeConsumer([ACCOUNT_A]);
    const requests = stubAccount();
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await runCredsCommand(['revoke', '--token-id', FOREIGN_ID])).toBe(
      true,
    );
    expect(deletes(requests)).toEqual([
      `DELETE https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_A}/tokens/${FOREIGN_ID}`,
    ]);
    expect(log.mock.calls.join(' ')).toContain(
      `revoked dns-token-from-2023 (${ACCOUNT_A}/${FOREIGN_ID})`,
    );
  });

  it('requires --token-id before touching the provider', async () => {
    initializeConsumer([ACCOUNT_A]);
    const requests = stubAccount();
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runCredsCommand(['revoke'])).toBe(false);
    expect(requests).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('revoke requires --token-id'),
    );
  });

  it('rejects a value that is not a token ID before touching the provider', async () => {
    initializeConsumer([ACCOUNT_A]);
    const requests = stubAccount();
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(
      await runCredsCommand(['revoke', '--token-id', 'dns-token-from-2023']),
    ).toBe(false);
    expect(requests).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('not a token ID: dns-token-from-2023'),
    );
  });

  it('refuses the bootstrap credential the broker authenticates with', async () => {
    initializeConsumer([ACCOUNT_A]);
    const requests = stubAccount();
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runCredsCommand(['revoke', '--token-id', BOOTSTRAP_ID])).toBe(
      false,
    );
    expect(deletes(requests)).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("is this account's broker bootstrap credential"),
    );
  });

  it('refuses a brokered token and points at the reconciled path', async () => {
    initializeConsumer([ACCOUNT_A]);
    const requests = stubAccount();
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runCredsCommand(['revoke', '--token-id', BROKERED_ID])).toBe(
      false,
    );
    expect(deletes(requests)).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        'delete ci:ci.dns_token from the SOPS target and run `standards creds apply`',
      ),
    );
  });

  it('refuses an ID the account does not hold', async () => {
    initializeConsumer([ACCOUNT_A]);
    const requests = stubAccount();
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runCredsCommand(['revoke', '--token-id', MISSING_ID])).toBe(
      false,
    );
    expect(deletes(requests)).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(`no token ${MISSING_ID} in account ${ACCOUNT_A}`),
    );
  });
});

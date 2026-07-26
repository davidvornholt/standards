import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  ACCOUNT_A,
  cleanupCredsAdd,
  initializeConsumer,
} from './creds-add-test-support';
import { runCredsCommand } from './creds-commands';
import {
  deletes,
  FOREIGN_ID,
  MISSING_ID,
  OTHER_REPO_ID,
  stubAccount,
} from './creds-revoke-test-support';

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

  it('deletes a token brokered to another repository under --force', async () => {
    const consumer = initializeConsumer([ACCOUNT_A]);
    const requests = stubAccount();
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    expect(
      await runCredsCommand([
        'revoke',
        '--token-id',
        OTHER_REPO_ID,
        '--dir',
        consumer,
        '--force',
      ]),
    ).toBe(true);
    expect(deletes(requests)).toEqual([
      `DELETE https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_A}/tokens/${OTHER_REPO_ID}`,
    ]);
    expect(log.mock.calls.join(' ')).toContain(
      'brokered to otherowner/otherrepo',
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

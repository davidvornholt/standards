import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  cleanupCredsAdd,
  initializeConsumer,
} from './creds-add-test-support';
import { runCredsCommand } from './creds-commands';
import {
  deletes,
  FOREIGN_ID,
  MALFORMED_ID,
  MISSING_ID,
  OTHER_REPO_ID,
  stubAccount,
} from './creds-revoke-test-support';

const deleteUrl = (account: string, tokenId: string): string =>
  `DELETE https://api.cloudflare.com/client/v4/accounts/${account}/tokens/${tokenId}`;

afterEach(cleanupCredsAdd);

describe('creds revoke', () => {
  it('deletes a token the broker did not mint', async () => {
    initializeConsumer([ACCOUNT_A]);
    const requests = stubAccount();
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await runCredsCommand(['revoke', '--token-id', FOREIGN_ID])).toBe(
      true,
    );
    expect(deletes(requests)).toEqual([deleteUrl(ACCOUNT_A, FOREIGN_ID)]);
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
    expect(deletes(requests)).toEqual([deleteUrl(ACCOUNT_A, OTHER_REPO_ID)]);
    expect(log.mock.calls.join(' ')).toContain(
      'brokered to otherowner/otherrepo',
    );
  });

  // `plan` reports a name inside this repository's namespace that the broker
  // does not mint and instructs the operator to retire it with this command.
  // A refusal here would turn that instruction into a dead end on the one path
  // that unblocks reconciliation.
  it('deletes a name claiming this repository namespace that does not parse', async () => {
    const consumer = initializeConsumer([ACCOUNT_A]);
    const requests = stubAccount();
    spyOn(console, 'log').mockImplementation(() => undefined);
    expect(
      await runCredsCommand([
        'revoke',
        '--token-id',
        MALFORMED_ID,
        '--dir',
        consumer,
      ]),
    ).toBe(true);
    expect(deletes(requests)).toEqual([deleteUrl(ACCOUNT_A, MALFORMED_ID)]);
  });

  it('stays failed and reports the provider when the delete is refused', async () => {
    initializeConsumer([ACCOUNT_A]);
    const requests = stubAccount({ denyDelete: true });
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runCredsCommand(['revoke', '--token-id', FOREIGN_ID])).toBe(
      false,
    );
    expect(deletes(requests)).toEqual([deleteUrl(ACCOUNT_A, FOREIGN_ID)]);
    expect(log.mock.calls.join(' ')).not.toContain('revoked');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('dns-token-from-2023: '),
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Insufficient permissions'),
    );
  });
});

// The broker store is machine-global, so one machine can hold several
// Cloudflare accounts and a token ID means nothing without the account it
// belongs to. Guessing would delete a token in the wrong account.
describe('creds revoke account selection', () => {
  it('refuses to guess between accounts and reaches neither', async () => {
    initializeConsumer([ACCOUNT_A, ACCOUNT_B]);
    const requests = stubAccount();
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runCredsCommand(['revoke', '--token-id', FOREIGN_ID])).toBe(
      false,
    );
    expect(requests).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('multiple Cloudflare accounts configured'),
    );
  });

  it('deletes in the named account when several are configured', async () => {
    initializeConsumer([ACCOUNT_A, ACCOUNT_B]);
    const requests = stubAccount();
    spyOn(console, 'log').mockImplementation(() => undefined);
    expect(
      await runCredsCommand([
        'revoke',
        '--token-id',
        FOREIGN_ID,
        '--account',
        ACCOUNT_B,
      ]),
    ).toBe(true);
    expect(deletes(requests)).toEqual([deleteUrl(ACCOUNT_B, FOREIGN_ID)]);
  });
});

describe('creds revoke argument validation', () => {
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

// Every class of token `creds revoke` must refuse. A refusal is only correct if
// it issued no DELETE and named the repository or machine the operator has to
// act in. What --force does and does not widen lives in
// `creds-revoke-force.test.ts`.

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  ACCOUNT_A,
  cleanupCredsAdd,
  initializeConsumer,
} from './creds-add-test-support';
import { runCredsCommand } from './creds-commands';
import {
  BOOTSTRAP_ID,
  BROKERED_ID,
  deletes,
  FOREIGN_ID,
  OTHER_MACHINE_BROKER_ID,
  OTHER_REPO_ID,
  stubAccount,
} from './creds-revoke-test-support';

afterEach(cleanupCredsAdd);

// Establishing the bootstrap identity is what proves which token must never be
// deleted and that the named one exists at all. If an unidentifiable account
// were survivable, both guards would fall away together.
describe('creds revoke provider identity', () => {
  it('refuses when the bootstrap identity cannot be established', async () => {
    initializeConsumer([ACCOUNT_A]);
    const requests = stubAccount({ verifiedId: null });
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runCredsCommand(['revoke', '--token-id', FOREIGN_ID])).toBe(
      false,
    );
    expect(deletes(requests)).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('valid token ID'),
    );
  });
});

describe('creds revoke refusals', () => {
  it('refuses every token named standards-broker, with its own message each', async () => {
    initializeConsumer([ACCOUNT_A]);
    const requests = stubAccount();
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runCredsCommand(['revoke', '--token-id', BOOTSTRAP_ID])).toBe(
      false,
    );
    expect(
      await runCredsCommand(['revoke', '--token-id', OTHER_MACHINE_BROKER_ID]),
    ).toBe(false);
    expect(deletes(requests)).toEqual([]);
    const [local, foreign] = error.mock.calls.map((call) => String(call[0]));
    expect(local).toContain("is this account's broker bootstrap credential");
    expect(foreign).toContain('belongs to another machine');
    expect(foreign).not.toEqual(local);
  });

  it('refuses a token brokered to this repository and points at the reconciled path', async () => {
    const consumer = initializeConsumer([ACCOUNT_A]);
    const requests = stubAccount();
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(
      await runCredsCommand([
        'revoke',
        '--token-id',
        BROKERED_ID,
        '--dir',
        consumer,
      ]),
    ).toBe(false);
    expect(deletes(requests)).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        "for this repository (davidvornholt/example); delete ci:ci.dns_token from this repository's SOPS target",
      ),
    );
  });

  it('refuses a token brokered to another repository and names that repository', async () => {
    const consumer = initializeConsumer([ACCOUNT_A]);
    const requests = stubAccount();
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(
      await runCredsCommand([
        'revoke',
        '--token-id',
        OTHER_REPO_ID,
        '--dir',
        consumer,
      ]),
    ).toBe(false);
    expect(deletes(requests)).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        'belongs to otherowner/otherrepo, and this checkout is davidvornholt/example',
      ),
    );
  });
});

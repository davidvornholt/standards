// Every class of token `creds revoke` must refuse. A refusal is only correct if
// it issued no DELETE and named the repository or machine the operator has to
// act in, together with what to do there. Each refusal is asserted fact by fact
// rather than as one span of prose. What --force does and does not widen lives
// in `creds-revoke-force.test.ts`.

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
  OTHER_OWNER_ID,
  OTHER_REPO_ID,
  RENAMED_BOOTSTRAP_ID,
  refusals,
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
    const [message = ''] = refusals(error);
    // The broker store is machine-global, so the account that failed is the one
    // fact the operator cannot reconstruct from the provider's own complaint —
    // and the provider's complaint is the only clue to why it failed.
    expect(message).toContain(`account ${ACCOUNT_A}`);
    expect(message).toContain('token verification returned no valid token ID');
  });
});

describe('creds revoke bootstrap refusals', () => {
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
    const [local, foreign] = refusals(error);
    expect(local).toContain("is this account's broker bootstrap credential");
    expect(foreign).toContain('belongs to another machine');
    expect(foreign).not.toEqual(local);
  });

  // The reserved name is a convention a dashboard rename can break; the
  // verified ID is not. Every other fixture carries the reserved name, so only
  // a renamed bootstrap credential shows whether the ID guard does any work.
  it("refuses this machine's bootstrap credential renamed out of the reserved name", async () => {
    initializeConsumer([ACCOUNT_A]);
    const requests = stubAccount({ verifiedId: RENAMED_BOOTSTRAP_ID });
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(
      await runCredsCommand(['revoke', '--token-id', RENAMED_BOOTSTRAP_ID]),
    ).toBe(false);
    expect(deletes(requests)).toEqual([]);
    const [message = ''] = refusals(error);
    expect(message).toContain("is this account's broker bootstrap credential");
    expect(message).not.toContain('another machine');
  });
});

describe('creds revoke brokered refusals', () => {
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
    const [message = ''] = refusals(error);
    expect(message).toContain('davidvornholt/example');
    expect(message).toContain('ci:ci.dns_token');
    expect(message).toContain('standards creds apply');
    // The owner of a token has a remedy that keeps secret and provider in step,
    // so --force must never be offered here as an alternative to taking it.
    expect(message).not.toContain('--force');
  });

  it('refuses a token brokered to another repository and points the remedy at it', async () => {
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
    const [message = ''] = refusals(error);
    // Both repositories appear in this message, so each name is asserted bound
    // to its role: naming them without their roles reads the same forwards and
    // backwards, and the reversed message tells the operator that the token
    // they are standing next to is theirs.
    expect(message).toContain('belongs to otherowner/otherrepo');
    expect(message).toContain('this checkout is davidvornholt/example');
    // Without the remedy the operator is left with --force and no correct
    // alternative in sight, which is the one outcome this message prevents.
    // It has to run in the owning repository: pointed at this one, it would
    // have the operator delete their own live SOPS key.
    expect(message).toContain("from otherowner/otherrepo's SOPS target");
    expect(message).toContain('ci:ci.dns_token');
    expect(message).toContain('standards creds apply');
  });

  // GitHub repository names are case-insensitive, so ownership cannot be
  // decided by exact string match — but they are owner-scoped, so it cannot be
  // decided by repository name alone either. This token shares this
  // repository's name and nothing else.
  it('refuses a token brokered under this repository name to another owner', async () => {
    const consumer = initializeConsumer([ACCOUNT_A]);
    const requests = stubAccount();
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(
      await runCredsCommand([
        'revoke',
        '--token-id',
        OTHER_OWNER_ID,
        '--dir',
        consumer,
      ]),
    ).toBe(false);
    expect(deletes(requests)).toEqual([]);
    const [message = ''] = refusals(error);
    expect(message).toContain('belongs to otherowner/example');
    expect(message).toContain('this checkout is davidvornholt/example');
  });
});

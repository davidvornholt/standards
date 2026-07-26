// --force widens exactly one refusal — a token brokered to a repository that is
// not this one — and every input that decision rests on comes from the origin
// remote. A remote that resolves to nothing, or to this repository under
// different casing, must fail closed with a remedy that works: both otherwise
// read as "not yours" and delete a live credential. Neither bootstrap guard —
// this machine's by verified ID, another machine's by reserved name — is
// widened at all.

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  ACCOUNT_A,
  cleanupCredsAdd,
  initializeConsumer,
  setConsumerOrigin,
} from './creds-add-test-support';
import { runCredsCommand } from './creds-commands';
import {
  BOOTSTRAP_ID,
  BROKERED_ID,
  deletes,
  OTHER_MACHINE_BROKER_ID,
  refusals,
  stubAccount,
} from './creds-revoke-test-support';

afterEach(cleanupCredsAdd);

const revokeWithForce = (tokenId: string, consumer: string): Promise<boolean> =>
  runCredsCommand([
    'revoke',
    '--token-id',
    tokenId,
    '--dir',
    consumer,
    '--force',
  ]);

describe('creds revoke --force', () => {
  // The guard on this machine's own bootstrap credential is matched by verified
  // ID rather than by name. Widening it would let one flag strip the broker of
  // every power it has, with no way to mint the credential back.
  it("refuses this machine's own bootstrap credential", async () => {
    const consumer = initializeConsumer([ACCOUNT_A]);
    const requests = stubAccount();
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await revokeWithForce(BOOTSTRAP_ID, consumer)).toBe(false);
    expect(deletes(requests)).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("is this account's broker bootstrap credential"),
    );
  });

  it("refuses another machine's bootstrap credential", async () => {
    const consumer = initializeConsumer([ACCOUNT_A]);
    const requests = stubAccount();
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await revokeWithForce(OTHER_MACHINE_BROKER_ID, consumer)).toBe(
      false,
    );
    expect(deletes(requests)).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('retire it in the Cloudflare dashboard'),
    );
  });

  it('refuses a token brokered to this repository', async () => {
    const consumer = initializeConsumer([ACCOUNT_A]);
    const requests = stubAccount();
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await revokeWithForce(BROKERED_ID, consumer)).toBe(false);
    expect(deletes(requests)).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('for this repository (davidvornholt/example)'),
    );
  });

  it('refuses when the origin remote resolves to no GitHub repository', async () => {
    const consumer = initializeConsumer([ACCOUNT_A]);
    setConsumerOrigin(
      consumer,
      'git@github-personal:davidvornholt/example.git',
    );
    const requests = stubAccount();
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await revokeWithForce(BROKERED_ID, consumer)).toBe(false);
    expect(deletes(requests)).toEqual([]);
    const [unresolved = ''] = refusals(error);
    expect(unresolved).toContain('cannot resolve the GitHub repository');
    // A refusal that only says no strands the operator, so this one names both
    // ways forward: fix the checkout, or act in the repository that owns it.
    expect(unresolved).toContain(
      'Re-run from a checkout whose origin remote names a GitHub repository',
    );
    expect(unresolved).toContain('from its SOPS target');
    expect(unresolved).toContain('standards creds apply');
  });

  // Reconciliation matches token names exactly, so a checkout that differs only
  // in capitalisation neither owns the token nor can act on it. Offering the
  // owner's remedy here would prescribe a no-op: `apply` would not recognise
  // the token either.
  it('refuses a token brokered to this repository under other casing', async () => {
    const consumer = initializeConsumer([ACCOUNT_A]);
    setConsumerOrigin(consumer, 'git@github.com:DavidVornholt/Example.git');
    const requests = stubAccount();
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await revokeWithForce(BROKERED_ID, consumer)).toBe(false);
    expect(deletes(requests)).toEqual([]);
    const [message = ''] = refusals(error);
    expect(message).toContain(
      'differs from davidvornholt/example only in capitalisation',
    );
    expect(message).toContain('Re-point the origin remote');
    expect(message).toContain('Cloudflare dashboard');
    expect(message).not.toContain('ci:ci.dns_token');
    expect(message).not.toContain('standards creds apply');
  });
});

// --force widens exactly one refusal — a token brokered to a repository that is
// not this one — and every input that decision rests on comes from the origin
// remote. A remote that resolves to nothing, or to this repository under
// different casing, must fail closed: both otherwise read as "not yours" and
// delete a live credential. Neither bootstrap guard is widened at all.

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  ACCOUNT_A,
  cleanupCredsAdd,
  initializeConsumer,
  setConsumerOrigin,
} from './creds-add-test-support';
import { runCredsCommand } from './creds-commands';
import {
  BROKERED_ID,
  deletes,
  OTHER_MACHINE_BROKER_ID,
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
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('cannot resolve the GitHub repository'),
    );
  });

  it('refuses a token brokered to this repository under other casing', async () => {
    const consumer = initializeConsumer([ACCOUNT_A]);
    setConsumerOrigin(consumer, 'git@github.com:DavidVornholt/Example.git');
    const requests = stubAccount();
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await revokeWithForce(BROKERED_ID, consumer)).toBe(false);
    expect(deletes(requests)).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('for this repository (davidvornholt/example)'),
    );
  });
});

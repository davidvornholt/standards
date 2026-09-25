import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isContainedPath } from './contained-path';
import { deleteAccountToken, verifyAccountToken } from './creds-cloudflare';
import type { CloudflareToken } from './creds-cloudflare-api';
import type { BrokeredTokenRef } from './creds-naming';
import { lookupS3Pair, s3PairPaths } from './creds-r2';
import { verifySopsStoredValue } from './creds-sops-value';
import type { CloudflareBrokerAccount } from './creds-store';
import { resolveBrokerPath } from './creds-store';
import { withBrokerLock } from './creds-store-lock';
import { resolveTargetRelResult } from './creds-target';
import { isRecord } from './github-settings-parse';
import { decryptSopsJson } from './sops-exec';

type Proof =
  | {
      readonly ok: true;
      readonly id: string | null;
      readonly values: ReadonlyArray<{
        readonly path: string;
        readonly value: string;
      }>;
    }
  | { readonly ok: false };
const storedProof = async (
  document: unknown,
  key: string,
  accountId: string,
): Promise<Proof> => {
  let node = document;
  for (const segment of key.split('.')) {
    if (!isRecord(node)) {
      return { ok: false };
    }
    if (!Object.hasOwn(node, segment)) {
      return { ok: true, id: null, values: [] };
    }
    node = node[segment];
  }
  if (typeof node === 'string') {
    const verified = await verifyAccountToken(accountId, node);
    return verified.ok && verified.value.status === 'active'
      ? {
          ok: true,
          id: verified.value.id,
          values: [{ path: key, value: node }],
        }
      : { ok: false };
  }
  const pair = lookupS3Pair(document, key);
  if (!pair.ok) {
    return { ok: false };
  }
  const [accessPath, secretPath] = s3PairPaths(key);
  return {
    ok: true,
    id: pair.accessKeyId,
    values: [
      { path: accessPath, value: pair.accessKeyId },
      { path: secretPath, value: pair.secretAccessKey },
    ],
  };
};

const unchangedStoredValues = (
  consumer: string,
  rel: string,
  proof: Extract<Proof, { readonly ok: true }>,
  ciphertext: Buffer,
): boolean =>
  proof.values.every(({ path, value }) => {
    const result = verifySopsStoredValue(consumer, rel, path, value);
    return result.ok && result.matches;
  }) && readFileSync(join(consumer, rel)).equals(ciphertext);

const isActiveDuplicate = (
  id: string | null,
  duplicates: ReadonlyArray<CloudflareToken>,
): boolean =>
  id === null ||
  duplicates.some((token) => token.id === id && token.status === 'active');

// Only the explicit non-stored member of a same-name duplicate set may be
// retired. Keep the current secret and every token if identity is uncertain.
export const revokeStoredDuplicate = async (input: {
  readonly consumer: string;
  readonly account: CloudflareBrokerAccount;
  readonly tokenId: string;
  readonly ref: BrokeredTokenRef;
  readonly duplicates: ReadonlyArray<CloudflareToken>;
}): Promise<string | null> =>
  withBrokerLock(resolveBrokerPath(), async () => {
    const { consumer, account, ref, tokenId, duplicates } = input;
    const target = resolveTargetRelResult(consumer, ref.target);
    if (!(target.ok && isContainedPath(consumer, target.rel, 'file'))) {
      return 'cannot safely resolve the duplicate token SOPS destination; keep its stored key intact';
    }
    const ciphertext = readFileSync(join(consumer, target.rel));
    const decrypted = decryptSopsJson(consumer, target.rel);
    if (!decrypted.ok) {
      return 'cannot decrypt the duplicate token destination; keep its stored key intact';
    }
    const proof = await storedProof(
      decrypted.value,
      ref.key,
      account.accountId,
    );
    if (!proof.ok) {
      return 'cannot prove which duplicate token the stored credential uses; keep its stored key intact';
    }
    if (!isActiveDuplicate(proof.id, duplicates)) {
      return 'stored credential does not identify an active duplicate; no token revoked';
    }
    if (proof.id === tokenId) {
      return `token ${tokenId} is the credential currently stored at ${ref.target}:${ref.key}; choose a different duplicate ID`;
    }
    if (!unchangedStoredValues(consumer, target.rel, proof, ciphertext)) {
      return 'stored credential changed or became unreadable during duplicate verification; no token revoked';
    }
    const deleted = await deleteAccountToken(
      account.accountId,
      account.token,
      tokenId,
    );
    return deleted.ok ? null : deleted.problem;
  });

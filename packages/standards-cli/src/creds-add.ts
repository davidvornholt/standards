import { commitCreatedCloudflareToken } from './creds-add-cloudflare-commit';
import { findManagedDestinationCollision } from './creds-add-collision';
import { resolveTokenPolicy } from './creds-add-policy';
import {
  inspectDestinations,
  resolveResourceFlags,
} from './creds-add-preflight';
import { createAccountToken } from './creds-cloudflare';
import type { TokenPolicy } from './creds-cloudflare-api';
import { cloudflareExpiresOn } from './creds-cloudflare-expiry';
import { resolveContext, selectAccount } from './creds-dest';
import { tokenNameOf } from './creds-naming';
import {
  DEFAULT_R2_JURISDICTION,
  type DestinationFormat,
  destinationWrites,
  type R2Jurisdiction,
  s3Endpoint,
  s3PairPaths,
} from './creds-r2';
import { readEncryptedKeys, setSopsValues } from './creds-sops';

const DEFAULT_TTL_DAYS = 90;
const DAY_MS = 86_400_000;

const printSuccess = (input: {
  readonly name: string;
  readonly permissions: ReadonlyArray<string>;
  readonly expiresOn: string;
  readonly destination: string;
  readonly format: DestinationFormat;
  readonly accountId: string;
  readonly jurisdiction: R2Jurisdiction;
  readonly policies: ReadonlyArray<TokenPolicy>;
}): void => {
  console.log(`standards creds: minted Cloudflare token ${input.name}`);
  console.log(`  permissions: ${input.permissions.join(', ')}`);
  // Read off the minted policies rather than the flags that asked for them:
  // a selection can add an account policy the flags do not mention, and the
  // reach of a token is the one thing worth stating from ground truth.
  console.log(
    `  resources: ${input.policies.flatMap((policy) => Object.keys(policy.resources)).join(', ')}`,
  );
  console.log(
    `  expires: ${input.expiresOn} (rotate via \`standards creds apply\`)`,
  );
  console.log(
    `  ${input.format === 's3' ? 'derived S3 credential pair' : 'value'} written to ${input.destination}`,
  );
  if (input.format === 's3') {
    console.log(
      `  S3 endpoint: ${s3Endpoint(input.accountId, input.jurisdiction)}`,
    );
  }
};

export const runCredsAddCloudflare = async (
  consumer: string,
  options: {
    readonly dest: string | undefined;
    readonly permissions: string | undefined;
    readonly account: string | undefined;
    readonly ttlDays: number | undefined;
    readonly bucket: string | undefined;
    readonly zone: string | undefined;
    readonly jurisdiction?: R2Jurisdiction;
    readonly s3: boolean;
  },
): Promise<boolean> => {
  if (options.s3 && options.bucket === undefined) {
    console.error(
      'standards creds: --s3 requires --bucket so the credential is backed by a bucket-scoped R2 policy',
    );
    return false;
  }
  const flags = resolveResourceFlags(options);
  if (!flags.ok) {
    console.error(`standards creds: ${flags.problem}`);
    return false;
  }
  const context = await resolveContext(consumer, options.dest);
  if (context === null) {
    return false;
  }
  const account = selectAccount(context.store, options.account);
  if (account === null) {
    return false;
  }
  const format: DestinationFormat = options.s3 ? 's3' : 'bearer';
  const paths =
    format === 's3' ? s3PairPaths(context.dest.key) : [context.dest.key];
  const destinationProblem = await inspectDestinations(
    consumer,
    context.rel,
    paths,
  );
  if (destinationProblem !== null) {
    console.error(`standards creds: ${destinationProblem}`);
    return false;
  }
  const encryptedKeys = await readEncryptedKeys(consumer, context.rel);
  if (!encryptedKeys.ok) {
    console.error(`standards creds: ${encryptedKeys.problem}`);
    return false;
  }
  const keys = new Set(encryptedKeys.keys);
  const resolved = await resolveTokenPolicy(account, {
    permissions: options.permissions,
    resource: flags.resource,
  });
  if (!resolved.ok) {
    console.error(`standards creds: ${resolved.problem}`);
    return false;
  }
  const name = tokenNameOf({ ...context.dest, repo: context.repo });
  const collisionProblem = await findManagedDestinationCollision(
    context,
    format,
    keys,
  );
  if (collisionProblem !== null) {
    console.error(`standards creds: ${collisionProblem}`);
    return false;
  }
  const ttlDays = options.ttlDays ?? DEFAULT_TTL_DAYS;
  const expiresOn = cloudflareExpiresOn(Date.now() + ttlDays * DAY_MS);
  const created = await createAccountToken(account.accountId, account.token, {
    name,
    expiresOn,
    condition: null,
    policies: resolved.policies,
  });
  if (!created.ok) {
    console.error(`standards creds: ${created.problem}`);
    return false;
  }
  const writes = destinationWrites(
    format,
    context.dest.key,
    created.value.id,
    created.value.value,
  );
  const written = setSopsValues(consumer, context.rel, writes);
  const committed = await commitCreatedCloudflareToken({
    consumer,
    rel: context.rel,
    writes,
    written,
    accountId: account.accountId,
    bootstrapToken: account.token,
    tokenId: created.value.id,
    name,
  });
  if (!committed.ok) {
    console.error(`standards creds: ${committed.problem}`);
    return false;
  }
  printSuccess({
    name,
    permissions: resolved.wanted,
    expiresOn,
    destination: `${context.rel} at ${context.dest.key}`,
    format,
    accountId: account.accountId,
    jurisdiction:
      flags.resource.kind === 'bucket'
        ? flags.resource.jurisdiction
        : DEFAULT_R2_JURISDICTION,
    policies: resolved.policies,
  });
  return true;
};

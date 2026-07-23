import { commitCreatedCloudflareToken } from './creds-add-cloudflare-commit';
import { resolveTokenPolicy } from './creds-add-policy';
import { createAccountToken, listAccountTokens } from './creds-cloudflare';
import { resolveContext, selectAccount } from './creds-dest';
import { tokenNameOf } from './creds-naming';
import {
  type DestinationFormat,
  destinationWrites,
  s3Endpoint,
  s3PairPaths,
} from './creds-r2';
import { inspectSopsScalarDestination, setSopsValues } from './creds-sops';

const DEFAULT_TTL_DAYS = 90;
const DAY_MS = 86_400_000;

const printSuccess = (input: {
  readonly name: string;
  readonly permissions: ReadonlyArray<string>;
  readonly expiresOn: string;
  readonly destination: string;
  readonly format: DestinationFormat;
  readonly accountId: string;
}): void => {
  console.log(`standards creds: minted Cloudflare token ${input.name}`);
  console.log(`  permissions: ${input.permissions.join(', ')}`);
  console.log(
    `  expires: ${input.expiresOn} (rotate via \`standards creds apply\`)`,
  );
  console.log(
    `  ${input.format === 's3' ? 'derived S3 credential pair' : 'value'} written to ${input.destination}`,
  );
  if (input.format === 's3') {
    console.log(`  S3 endpoint: ${s3Endpoint(input.accountId)}`);
  }
};

const inspectDestinations = async (
  consumer: string,
  rel: string,
  paths: ReadonlyArray<string>,
): Promise<string | null> => {
  const inspected = await Promise.all(
    paths.map((path) => inspectSopsScalarDestination(consumer, rel, path)),
  );
  const blocked = inspected.find((result) => !result.ok);
  return blocked !== undefined && !blocked.ok ? blocked.problem : null;
};

export const runCredsAddCloudflare = async (
  consumer: string,
  options: {
    readonly dest: string | undefined;
    readonly permissions: string | undefined;
    readonly account: string | undefined;
    readonly ttlDays: number | undefined;
    readonly bucket: string | undefined;
    readonly s3: boolean;
  },
): Promise<boolean> => {
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
  const resolved = await resolveTokenPolicy(account, options);
  if (!resolved.ok) {
    console.error(`standards creds: ${resolved.problem}`);
    return false;
  }
  const name = tokenNameOf({ ...context.dest, repo: context.repo });
  const listings = await Promise.all(
    context.store.cloudflare.map(async (configured) => ({
      accountId: configured.accountId,
      listed: await listAccountTokens(configured.accountId, configured.token),
    })),
  );
  const failedListing = listings.find(({ listed }) => !listed.ok);
  if (failedListing?.listed.ok === false) {
    console.error(
      `standards creds: account ${failedListing.accountId}: ${failedListing.listed.problem}; cannot prove the destination is unambiguous`,
    );
    return false;
  }
  const collisions = listings.flatMap(({ accountId, listed }) =>
    listed.ok && listed.value.some((token) => token.name === name)
      ? [accountId]
      : [],
  );
  if (collisions.length > 0) {
    console.error(
      `standards creds: token ${name} already exists in Cloudflare account(s) ${collisions.join(', ')}; one SOPS destination may be managed by only one account`,
    );
    return false;
  }
  const ttlDays = options.ttlDays ?? DEFAULT_TTL_DAYS;
  const expiresOn = new Date(Date.now() + ttlDays * DAY_MS).toISOString();
  const created = await createAccountToken(account.accountId, account.token, {
    name,
    expiresOn,
    condition: null,
    policies: [resolved.policy],
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
  });
  return true;
};

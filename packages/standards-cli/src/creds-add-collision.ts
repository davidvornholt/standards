import { listAccountTokens } from './creds-cloudflare';
import type { ResolvedContext } from './creds-dest';
import { parseTokenName } from './creds-naming';
import {
  type DestinationFormat,
  destinationFootprint,
  destinationFootprintsIntersect,
  inferredDestinationFootprint,
} from './creds-r2';

export const findManagedDestinationCollision = async (
  context: ResolvedContext,
  format: DestinationFormat,
  keys: ReadonlySet<string>,
): Promise<string | null> => {
  const listings = await Promise.all(
    context.store.cloudflare.map(async (configured) => ({
      accountId: configured.accountId,
      listed: await listAccountTokens(configured.accountId, configured.token),
    })),
  );
  const failed = listings.find(({ listed }) => !listed.ok);
  if (failed?.listed.ok === false) {
    return `account ${failed.accountId}: ${failed.listed.problem}; cannot prove the destination is unambiguous`;
  }
  const wanted = destinationFootprint(format, context.dest.key);
  const collisions = listings.flatMap(({ accountId, listed }) =>
    listed.ok
      ? listed.value.flatMap((token) => {
          const ref = parseTokenName(token.name, context.repo);
          return ref !== null &&
            ref.target === context.dest.target &&
            (ref.key === context.dest.key ||
              destinationFootprintsIntersect(
                wanted,
                inferredDestinationFootprint(keys, ref.key),
              ))
            ? [`${accountId}/${token.id} (${ref.key})`]
            : [];
        })
      : [],
  );
  return collisions.length === 0
    ? null
    : `managed Cloudflare token already exists at ${collisions.join(', ')} and conflicts with ${context.dest.target}:${context.dest.key} by exact identity or destination footprint; one SOPS destination may be managed by only one account`;
};

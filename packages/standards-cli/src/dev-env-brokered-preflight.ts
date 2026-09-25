import type { BrokeredS3Reference } from './dev-env-brokered';
import {
  brokeredReferenceIdentity,
  resolveBrokeredSource,
} from './dev-env-brokered-source';
import type { ComposedDevEnvTarget } from './dev-env-compose';

type SelectedReference = Readonly<{
  label: string;
  reference: BrokeredS3Reference;
}>;
type Source = Readonly<{ root: string; rel: string }>;
const selectedReferences = (
  targets: ReadonlyArray<ComposedDevEnvTarget>,
): ReadonlyArray<SelectedReference> =>
  targets.flatMap((target) =>
    Object.entries(target.env).flatMap(([key, reference]) =>
      typeof reference === 'string'
        ? []
        : [
            {
              label: `${target.group}.${target.workspace}.${key} reference to secrets target "${reference.brokeredS3}"`,
              reference,
            },
          ],
    ),
  );

export const prepareBrokeredSources = (
  consumer: string,
  targets: ReadonlyArray<ComposedDevEnvTarget>,
  allowed: ReadonlySet<string>,
  preserved: ReadonlySet<string>,
): Readonly<{
  sources: ReadonlyMap<BrokeredS3Reference, Source>;
  problems: ReadonlyArray<string>;
}> => {
  const sources = new Map<BrokeredS3Reference, Source>();
  const roots = new Map<string, string>();
  const problems = selectedReferences(targets).flatMap(
    ({ label, reference }) => {
      const identity = brokeredReferenceIdentity(reference);
      if (!allowed.has(identity)) {
        return [
          `${label}: unauthorized brokered S3 pair; add "${identity}" to the encrypted secrets/dev.yaml brokeredReferences allowlist`,
        ];
      }
      if (preserved.has(identity)) {
        return [];
      }
      const resolved = resolveBrokeredSource(consumer, reference);
      if (!resolved.ok) {
        return [`${label}: ${resolved.problem}`];
      }
      if (reference.source !== undefined) {
        const previous = roots.get(reference.source.repository);
        if (previous !== undefined && previous !== resolved.root) {
          return [
            `${label}: one source repository must resolve to one checkout per generation`,
          ];
        }
        roots.set(reference.source.repository, resolved.root);
      }
      sources.set(reference, resolved);
      return [];
    },
  );
  return { sources, problems };
};

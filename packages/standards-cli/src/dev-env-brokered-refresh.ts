// After the creds broker writes into a SOPS target, the generated dev env
// files are stale if any workspace env key references a brokered pair in
// that target. Regenerating here closes the rotation loop: a renewed pair
// reaches every generated .env.local without a manual copy step.

import { resolveTargetRelResult } from './creds-target';
import { runDevEnv } from './dev-env';
import { parseDevEnvDocument } from './dev-env-document';
import { readPlainLayer } from './dev-env-plain-layer';

const DEV_PLAIN_LAYERS = ['config/dev.yaml', 'config/dev.local.yaml'] as const;

type LayerReferenceDiscovery = {
  readonly references: ReadonlyArray<{
    readonly target: string;
    readonly key: string;
  }>;
  readonly problems: ReadonlyArray<string>;
};

const layerReferenceTargets = (
  consumer: string,
  layerRel: string,
): LayerReferenceDiscovery => {
  const layer = readPlainLayer(consumer, layerRel);
  if (layer.input === null) {
    return { references: [], problems: layer.problems };
  }
  const document = parseDevEnvDocument(
    layer.input.raw,
    layerRel,
    'configuration',
  );
  return {
    references: document.targets.flatMap((target) =>
      Object.values(target.env).flatMap((value) =>
        typeof value === 'string'
          ? []
          : [{ target: value.brokeredS3, key: value.key }],
      ),
    ),
    problems: [...layer.problems, ...document.problems],
  };
};

type BrokeredReferenceDiscovery = {
  readonly references: ReadonlySet<string>;
  readonly problems: ReadonlyArray<string>;
};

export type BrokeredRefreshEvidence = {
  readonly target: string;
  readonly key: string;
  readonly safety: 'verified' | 'unsafe';
};

const referenceIdentity = (target: string, key: string): string =>
  `${target}:${key}`;

const discoverBrokeredReferenceRels = (
  consumer: string,
): BrokeredReferenceDiscovery => {
  const references = new Set<string>();
  const problems: Array<string> = [];
  for (const layerRel of DEV_PLAIN_LAYERS) {
    const layer = layerReferenceTargets(consumer, layerRel);
    problems.push(...layer.problems);
    for (const reference of layer.references) {
      const resolved = resolveTargetRelResult(consumer, reference.target);
      if (resolved.ok) {
        references.add(referenceIdentity(reference.target, reference.key));
      } else {
        problems.push(
          resolved.kind === 'ambiguous'
            ? `dev config references ${resolved.problem}`
            : `dev config references secrets target "${reference.target}", but it is missing or is not a contained regular SOPS file`,
        );
      }
    }
  }
  return { references, problems };
};

export const refreshDevEnvForSopsWrites = async (
  consumer: string,
  evidence: ReadonlyArray<BrokeredRefreshEvidence>,
): Promise<boolean> => {
  if (evidence.length === 0) {
    return true;
  }
  const discovery = discoverBrokeredReferenceRels(consumer);
  if (discovery.problems.length > 0) {
    console.error(
      `standards creds: cannot determine whether changed credentials require dev env regeneration because the configuration has ${discovery.problems.length} problem(s):`,
    );
    console.error(
      discovery.problems.map((problem) => `  - ${problem}`).join('\n'),
    );
    console.error(
      'standards creds: credential changes were written, but generated .env.local files were not updated; fix the configuration and run `bun standards dev-env`',
    );
    return false;
  }
  const unsafe = new Set(
    evidence
      .filter((entry) => entry.safety === 'unsafe')
      .map((entry) => referenceIdentity(entry.target, entry.key)),
  );
  const verified = new Set(
    evidence
      .filter((entry) => entry.safety === 'verified')
      .map((entry) => referenceIdentity(entry.target, entry.key)),
  );
  const changedReferences = [...verified].filter(
    (reference) =>
      discovery.references.has(reference) && !unsafe.has(reference),
  );
  if (changedReferences.length === 0) {
    return true;
  }
  console.log(
    'standards creds: regenerating dev env files (a brokered pair referenced by the dev config changed)',
  );
  return await runDevEnv(consumer, {
    preservedBrokeredReferences: new Set(
      [...unsafe].filter((reference) => discovery.references.has(reference)),
    ),
  });
};

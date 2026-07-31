// After the creds broker writes into a SOPS target, the generated dev env
// files are stale if any workspace env key references a brokered pair in
// that target. Regenerating here closes the rotation loop: a renewed pair
// reaches every generated .env.local without a manual copy step.

import { resolveTargetRel } from './creds-dest';
import { runDevEnv } from './dev-env';
import { parseDevEnvDocument } from './dev-env-document';
import { readPlainLayer } from './dev-env-plain-layer';

const DEV_PLAIN_LAYERS = ['config/dev.yaml', 'config/dev.local.yaml'] as const;

type LayerReferenceDiscovery = {
  readonly targetNames: ReadonlyArray<string>;
  readonly problems: ReadonlyArray<string>;
};

const layerReferenceTargets = (
  consumer: string,
  layerRel: string,
): LayerReferenceDiscovery => {
  const layer = readPlainLayer(consumer, layerRel);
  if (layer.input === null) {
    return { targetNames: [], problems: layer.problems };
  }
  const document = parseDevEnvDocument(
    layer.input.raw,
    layerRel,
    'configuration',
  );
  return {
    targetNames: document.targets.flatMap((target) =>
      Object.values(target.env).flatMap((value) =>
        typeof value === 'string' ? [] : [value.brokeredS3],
      ),
    ),
    problems: [...layer.problems, ...document.problems],
  };
};

type BrokeredReferenceDiscovery = {
  readonly rels: ReadonlySet<string>;
  readonly problems: ReadonlyArray<string>;
};

const discoverBrokeredReferenceRels = (
  consumer: string,
): BrokeredReferenceDiscovery => {
  const rels = new Set<string>();
  const problems: Array<string> = [];
  for (const layerRel of DEV_PLAIN_LAYERS) {
    const layer = layerReferenceTargets(consumer, layerRel);
    problems.push(...layer.problems);
    for (const targetName of layer.targetNames) {
      const rel = resolveTargetRel(consumer, targetName);
      if (rel === null) {
        problems.push(
          `dev config references secrets target "${targetName}", but it is missing or is not a contained regular SOPS file`,
        );
      } else {
        rels.add(rel);
      }
    }
  }
  return { rels, problems };
};

export const refreshDevEnvForSopsWrites = async (
  consumer: string,
  writtenRels: ReadonlyArray<string>,
): Promise<boolean> => {
  if (writtenRels.length === 0) {
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
  if (!writtenRels.some((rel) => discovery.rels.has(rel))) {
    return true;
  }
  console.log(
    'standards creds: regenerating dev env files (a brokered pair referenced by the dev config changed)',
  );
  return await runDevEnv(consumer);
};

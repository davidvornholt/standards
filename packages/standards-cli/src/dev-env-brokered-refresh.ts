// After the creds broker writes into a SOPS target, the generated dev env
// files are stale if any workspace env key references a brokered pair in
// that target. Regenerating here closes the rotation loop: a renewed pair
// reaches every generated .env.local without a manual copy step.

import { resolveTargetRel } from './creds-dest';
import { runDevEnv } from './dev-env';
import { parseDevEnvDocument } from './dev-env-document';
import { readPlainLayer } from './dev-env-plain-layer';

const DEV_PLAIN_LAYERS = ['config/dev.yaml', 'config/dev.local.yaml'] as const;

const layerReferenceTargets = (
  consumer: string,
  layerRel: string,
): ReadonlyArray<string> => {
  const layer = readPlainLayer(consumer, layerRel);
  if (layer.input === null) {
    return [];
  }
  const document = parseDevEnvDocument(
    layer.input.raw,
    layerRel,
    'configuration',
  );
  return document.targets.flatMap((target) =>
    Object.values(target.env).flatMap((value) =>
      typeof value === 'string' ? [] : [value.brokeredS3],
    ),
  );
};

export const collectBrokeredReferenceRels = (
  consumer: string,
): ReadonlySet<string> => {
  const rels = new Set<string>();
  for (const layerRel of DEV_PLAIN_LAYERS) {
    for (const targetName of layerReferenceTargets(consumer, layerRel)) {
      const rel = resolveTargetRel(consumer, targetName);
      if (rel !== null) {
        rels.add(rel);
      }
    }
  }
  return rels;
};

// A malformed dev config must not fail a creds write that already committed
// durably, so collection reads best-effort; `dev-env` itself reports layer
// problems when regeneration runs.
export const refreshDevEnvForSopsWrites = async (
  consumer: string,
  writtenRels: ReadonlyArray<string>,
): Promise<boolean> => {
  const referenced = collectBrokeredReferenceRels(consumer);
  if (!writtenRels.some((rel) => referenced.has(rel))) {
    return true;
  }
  console.log(
    'standards creds: regenerating dev env files (a brokered pair referenced by the dev config changed)',
  );
  return await runDevEnv(consumer);
};

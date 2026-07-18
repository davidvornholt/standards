// Composes the generated .github/dependabot.yml from the canonical base and
// the optional repo-owned additive overlay.

import {
  parseDependabot,
  parseLocal,
  type ValidatedUpdate,
  validateUpdates,
} from './dependabot-compose-input';
import {
  overlapsUpdateTarget,
  sameUpdateTarget,
  type UpdateBlock,
  updateTargetDescription,
} from './dependabot-update';
import { emitYamlDocument } from './yaml-emit';

export const DEPENDABOT_FILE = '.github/dependabot.yml';
export const DEPENDABOT_BASE_FILE = '.github/dependabot.base.yml';
export const DEPENDABOT_LOCAL_FILE = '.github/dependabot.local.yml';

const GENERATED_HEADER = `# GENERATED FILE - do not edit. \`bun standards sync\` (or
# \`bun standards dependabot --write\`) composes ${DEPENDABOT_BASE_FILE}
# (canonical) with ${DEPENDABOT_LOCAL_FILE} (repo-owned) into this file.
`;

const MERGE_KEYS = new Set([
  'package-ecosystem',
  'directory',
  'directories',
  'target-branch',
  'ignore',
  'registries',
]);

const mergeMatchingBlock = (
  target: UpdateBlock,
  local: ValidatedUpdate,
  problems: Array<string>,
): void => {
  const extraKeys = Object.keys(local.block).filter(
    (key) => !MERGE_KEYS.has(key),
  );
  if (extraKeys.length > 0) {
    problems.push(
      `${local.label} matches a canonical block and may only add ignore or registries entries; remove: ${extraKeys.join(', ')}`,
    );
    return;
  }
  const hasIgnore =
    Array.isArray(local.block.ignore) && local.block.ignore.length > 0;
  const hasRegistries =
    Array.isArray(local.block.registries) && local.block.registries.length > 0;
  if (!(hasIgnore || hasRegistries)) {
    problems.push(
      `${local.label} matches a canonical block and must add a non-empty ignore or registries list`,
    );
    return;
  }
  if (hasIgnore) {
    target.ignore = [
      ...((target.ignore as ReadonlyArray<unknown> | undefined) ?? []),
      ...(local.block.ignore as ReadonlyArray<unknown>),
    ];
  }
  if (hasRegistries) {
    target.registries = [
      ...new Set([
        ...((target.registries as ReadonlyArray<string> | undefined) ?? []),
        ...(local.block.registries as ReadonlyArray<string>),
      ]),
    ];
  }
};

const mergeUpdates = (
  baseUpdates: ReadonlyArray<ValidatedUpdate>,
  localUpdates: ReadonlyArray<ValidatedUpdate>,
  problems: Array<string>,
): Array<UpdateBlock> => {
  const updates = baseUpdates.map(({ block }) => ({ ...block }));
  for (const localUpdate of localUpdates) {
    const matchingIndex = baseUpdates.findIndex(({ target }) =>
      sameUpdateTarget(target, localUpdate.target),
    );
    const overlapping = baseUpdates.find(({ target }) =>
      overlapsUpdateTarget(target, localUpdate.target),
    );
    if (matchingIndex >= 0) {
      const target = updates[matchingIndex];
      if (target !== undefined) {
        mergeMatchingBlock(target, localUpdate, problems);
      }
    } else if (overlapping === undefined) {
      updates.push({ ...localUpdate.block });
    } else {
      problems.push(
        `${localUpdate.label} overlaps ${overlapping.label}: ${updateTargetDescription(localUpdate.target)}`,
      );
    }
  }
  return updates;
};

const inspectRegistryReferencesExist = (
  updates: ReadonlyArray<UpdateBlock>,
  registryNames: ReadonlySet<string>,
  problems: Array<string>,
): void => {
  for (const [index, update] of updates.entries()) {
    if (Array.isArray(update.registries)) {
      const missing = update.registries.filter(
        (name) => name !== '*' && !registryNames.has(String(name)),
      );
      if (missing.length > 0) {
        problems.push(
          `${DEPENDABOT_FILE} updates[${index}].registries references undefined registries: ${missing.join(', ')}`,
        );
      }
    }
  }
};

export type DependabotCompose = {
  readonly composed: string | null;
  readonly problems: ReadonlyArray<string>;
};

export const composeDependabot = (
  baseRaw: string,
  localRaw: string | null,
): DependabotCompose => {
  const problems: Array<string> = [];
  const base = parseDependabot(baseRaw, DEPENDABOT_BASE_FILE, problems);
  const local =
    localRaw === null
      ? { updates: [], registries: {} }
      : parseLocal(localRaw, DEPENDABOT_LOCAL_FILE, problems);
  if (base === null || local === null) {
    return { composed: null, problems };
  }
  const baseUpdates = validateUpdates(
    base.updates,
    DEPENDABOT_BASE_FILE,
    problems,
  );
  const localUpdates = validateUpdates(
    local.updates,
    DEPENDABOT_LOCAL_FILE,
    problems,
  );
  const registryCollisions = Object.keys(local.registries).filter((name) =>
    Object.hasOwn(base.registries, name),
  );
  if (registryCollisions.length > 0) {
    problems.push(
      `${DEPENDABOT_LOCAL_FILE} registries collide with canonical registries: ${registryCollisions.join(', ')}`,
    );
  }
  if (problems.length > 0) {
    return { composed: null, problems };
  }
  const updates = mergeUpdates(baseUpdates, localUpdates, problems);
  const registries = { ...base.registries, ...local.registries };
  inspectRegistryReferencesExist(
    updates,
    new Set(Object.keys(registries)),
    problems,
  );
  if (problems.length > 0) {
    return { composed: null, problems };
  }
  const document = {
    ...base.document,
    ...(Object.keys(registries).length > 0 ? { registries } : {}),
    updates,
  };
  return {
    composed: `${GENERATED_HEADER}${emitYamlDocument(document)}`,
    problems: [],
  };
};

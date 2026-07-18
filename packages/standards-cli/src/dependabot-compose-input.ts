import {
  inspectIgnore,
  inspectRegistryReferences,
  overlapsUpdateTarget,
  type UpdateBlock,
  type UpdateTarget,
  updateTarget,
  updateTargetDescription,
} from './dependabot-update';
import { isRecord } from './github-settings-parse';
import { parseYaml } from './yaml-parse';

export type ParsedDependabot = {
  readonly document: Record<string, unknown>;
  readonly updates: ReadonlyArray<UpdateBlock>;
  readonly registries: Record<string, unknown>;
};

export type ParsedLocal = {
  readonly updates: ReadonlyArray<UpdateBlock>;
  readonly registries: Record<string, unknown>;
};

export type ValidatedUpdate = {
  readonly block: UpdateBlock;
  readonly target: UpdateTarget;
  readonly label: string;
};

const inspectRegistries = (
  registries: unknown,
  label: string,
  problems: Array<string>,
): Record<string, unknown> => {
  if (registries === undefined) {
    return {};
  }
  if (!isRecord(registries)) {
    problems.push(`${label} registries must be a mapping`);
    return {};
  }
  for (const [name, registry] of Object.entries(registries)) {
    if (!isRecord(registry)) {
      problems.push(`${label} registries.${name} must be a mapping`);
    }
  }
  return registries;
};

export const parseDependabot = (
  raw: string,
  label: string,
  problems: Array<string>,
): ParsedDependabot | null => {
  const { value, problem } = parseYaml(raw, label);
  if (problem !== null) {
    problems.push(problem);
    return null;
  }
  if (!(isRecord(value) && Array.isArray(value.updates))) {
    problems.push(`${label} must define an updates list`);
    return null;
  }
  if (!value.updates.every(isRecord)) {
    problems.push(`${label} updates entries must be mappings`);
    return null;
  }
  return {
    document: value,
    updates: value.updates,
    registries: inspectRegistries(value.registries, label, problems),
  };
};

export const parseLocal = (
  raw: string,
  label: string,
  problems: Array<string>,
): ParsedLocal | null => {
  const { value, problem } = parseYaml(raw, label);
  if (problem !== null) {
    problems.push(problem);
    return null;
  }
  if (value === null || value === undefined) {
    return { updates: [], registries: {} };
  }
  if (!isRecord(value)) {
    problems.push(`${label} must contain a YAML mapping`);
    return null;
  }
  const unknownKeys = Object.keys(value).filter(
    (key) => key !== 'updates' && key !== 'registries',
  );
  if (unknownKeys.length > 0) {
    problems.push(
      `${label} may only define "updates" and "registries"; remove: ${unknownKeys.join(', ')}`,
    );
  }
  const updates = value.updates ?? [];
  if (!(Array.isArray(updates) && updates.every(isRecord))) {
    problems.push(`${label} updates must be a list of mappings`);
    return null;
  }
  return {
    updates,
    registries: inspectRegistries(value.registries, label, problems),
  };
};

export const validateUpdates = (
  updates: ReadonlyArray<UpdateBlock>,
  label: string,
  problems: Array<string>,
): ReadonlyArray<ValidatedUpdate> => {
  const validated: Array<ValidatedUpdate> = [];
  for (const [index, block] of updates.entries()) {
    const blockLabel = `${label} updates[${index}]`;
    problems.push(...inspectIgnore(block.ignore, blockLabel));
    problems.push(...inspectRegistryReferences(block.registries, blockLabel));
    const target = updateTarget(block, blockLabel, problems);
    if (target !== null) {
      validated.push({ block, target, label: blockLabel });
    }
  }
  for (const [index, candidate] of validated.entries()) {
    for (const earlier of validated.slice(0, index)) {
      if (overlapsUpdateTarget(candidate.target, earlier.target)) {
        problems.push(
          `${candidate.label} overlaps ${earlier.label}: ${updateTargetDescription(candidate.target)}`,
        );
      }
    }
  }
  return validated;
};

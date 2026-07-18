// Composes the generated .github/dependabot.yml from the canonical
// .github/dependabot.base.yml and the optional repo-owned
// .github/dependabot.local.yml. The seam is additive-only: a local update
// block either adds a new ecosystem or appends ignore holds to the matching
// canonical block; it can never override or remove canonical configuration.
// Like cli.ts, this module is zero-dependency so `bunx` can execute the
// published package.

import { isNonEmptyString, isRecord } from './github-settings-parse';
import { emitYamlDocument } from './yaml-emit';

const { YAML: BunYaml } = await import('bun');

export const DEPENDABOT_FILE = '.github/dependabot.yml';
export const DEPENDABOT_BASE_FILE = '.github/dependabot.base.yml';
export const DEPENDABOT_LOCAL_FILE = '.github/dependabot.local.yml';

const GENERATED_HEADER = `# GENERATED FILE - do not edit. \`bun standards sync\` (or
# \`bun standards dependabot --write\`) composes ${DEPENDABOT_BASE_FILE}
# (canonical) with ${DEPENDABOT_LOCAL_FILE} (repo-owned) into this file.
`;

type UpdateBlock = Record<string, unknown>;

// A local block matching a canonical block may only carry the identity keys
// plus the ignore list it appends.
const MERGE_KEYS = new Set([
  'package-ecosystem',
  'directory',
  'directories',
  'ignore',
]);

const parseYaml = (
  raw: string,
  label: string,
): { readonly value: unknown; readonly problem: string | null } => {
  try {
    return { value: BunYaml.parse(raw) as unknown, problem: null };
  } catch {
    return { value: null, problem: `${label} must contain valid YAML` };
  }
};

type ParsedBase = {
  readonly document: Record<string, unknown>;
  readonly updates: ReadonlyArray<UpdateBlock>;
};

const parseBase = (raw: string, problems: Array<string>): ParsedBase | null => {
  const { value, problem } = parseYaml(raw, DEPENDABOT_BASE_FILE);
  if (problem !== null) {
    problems.push(problem);
    return null;
  }
  if (!(isRecord(value) && Array.isArray(value.updates))) {
    problems.push(`${DEPENDABOT_BASE_FILE} must define an updates list`);
    return null;
  }
  if (!value.updates.every(isRecord)) {
    problems.push(`${DEPENDABOT_BASE_FILE} updates entries must be mappings`);
    return null;
  }
  return { document: value, updates: value.updates };
};

// An empty or comments-only local file parses to null and means "no additions".
const parseLocal = (
  raw: string,
  problems: Array<string>,
): ReadonlyArray<UpdateBlock> => {
  const { value, problem } = parseYaml(raw, DEPENDABOT_LOCAL_FILE);
  if (problem !== null) {
    problems.push(problem);
    return [];
  }
  if (value === null || value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    problems.push(`${DEPENDABOT_LOCAL_FILE} must contain a YAML mapping`);
    return [];
  }
  const unknownKeys = Object.keys(value).filter((key) => key !== 'updates');
  if (unknownKeys.length > 0) {
    problems.push(
      `${DEPENDABOT_LOCAL_FILE} may only define "updates"; remove: ${unknownKeys.join(', ')}`,
    );
  }
  if (value.updates === undefined) {
    return [];
  }
  if (!(Array.isArray(value.updates) && value.updates.every(isRecord))) {
    problems.push(
      `${DEPENDABOT_LOCAL_FILE} updates must be a list of mappings`,
    );
    return [];
  }
  for (const block of value.updates) {
    if (!isNonEmptyString(block['package-ecosystem'])) {
      problems.push(
        `${DEPENDABOT_LOCAL_FILE} update blocks must define package-ecosystem`,
      );
    }
  }
  return value.updates;
};

// Identity is the ecosystem plus its directory targeting; Dependabot rejects
// two blocks with the same identity, so a matching local block is a merge.
const blockIdentity = (block: UpdateBlock): string =>
  JSON.stringify([
    block['package-ecosystem'] ?? null,
    block.directory ?? null,
    block.directories ?? null,
  ]);

const mergeLocalBlock = (
  updates: Array<UpdateBlock>,
  localBlock: UpdateBlock,
  problems: Array<string>,
): void => {
  const identity = blockIdentity(localBlock);
  const target = updates.find((block) => blockIdentity(block) === identity);
  if (target === undefined) {
    updates.push(localBlock);
    return;
  }
  const ecosystem = String(localBlock['package-ecosystem']);
  const extraKeys = Object.keys(localBlock).filter(
    (key) => !MERGE_KEYS.has(key),
  );
  if (extraKeys.length > 0) {
    problems.push(
      `${DEPENDABOT_LOCAL_FILE} update for "${ecosystem}" matches a canonical block and may only add ignore entries; remove: ${extraKeys.join(', ')}`,
    );
    return;
  }
  const { ignore } = localBlock;
  if (!(Array.isArray(ignore) && ignore.length > 0 && ignore.every(isRecord))) {
    problems.push(
      `${DEPENDABOT_LOCAL_FILE} update for "${ecosystem}" matches a canonical block and must add a non-empty ignore list`,
    );
    return;
  }
  const existing = Array.isArray(target.ignore) ? target.ignore : [];
  target.ignore = [...existing, ...ignore];
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
  const base = parseBase(baseRaw, problems);
  const localUpdates = localRaw === null ? [] : parseLocal(localRaw, problems);
  if (new Set(localUpdates.map(blockIdentity)).size !== localUpdates.length) {
    problems.push(
      `${DEPENDABOT_LOCAL_FILE} update blocks must be unique per ecosystem and directory`,
    );
  }
  if (base === null || problems.length > 0) {
    return { composed: null, problems };
  }
  const updates = base.updates.map((block) => ({ ...block }));
  for (const block of localUpdates) {
    mergeLocalBlock(updates, block, problems);
  }
  if (problems.length > 0) {
    return { composed: null, problems };
  }
  const document = { ...base.document, updates };
  return {
    composed: `${GENERATED_HEADER}${emitYamlDocument(document)}`,
    problems: [],
  };
};

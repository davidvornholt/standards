import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { isRecord } from './github-settings-parse';
import {
  DEPENDABOT_FILE,
  DEPENDABOT_LOCAL_MARKER,
  retiredDependabotLayout,
  splitManaged,
} from './sync-payload';
import { parseYaml } from './yaml-parse';

const TRAILING_SLASH = /\/$/u;

// `infra`, `/infra`, and `/infra/` name the same directory.
const normalizeDirectory = (directory: string): string => {
  const normalized = posix.normalize(`/${directory}`);
  return normalized.length > 1
    ? normalized.replace(TRAILING_SLASH, '')
    : normalized;
};

const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];

// One description per ecosystem, directory, and target branch that the block
// updates. Dependabot itself rejects a block it can't read, so this only
// describes what it can.
const updateTargets = (block: unknown): ReadonlyArray<string> => {
  if (!isRecord(block) || typeof block['package-ecosystem'] !== 'string') {
    return [];
  }
  const ecosystem = block['package-ecosystem'];
  const branch =
    typeof block['target-branch'] === 'string'
      ? `, target-branch "${block['target-branch']}"`
      : '';
  const directories = [
    ...(typeof block.directory === 'string' ? [block.directory] : []),
    ...strings(block.directories),
  ];
  return directories.map(
    (directory) =>
      `package-ecosystem "${ecosystem}", directory "${normalizeDirectory(directory)}"${branch}`,
  );
};

// Dependabot refuses a config with two update blocks for the same ecosystem,
// directory, and target branch, which is what a repository's own block that
// repeats a shared one produces. Directory globs are compared as written.
export const inspectDependabot = (raw: string): ReadonlyArray<string> => {
  if (splitManaged(DEPENDABOT_FILE, raw) === null) {
    return [
      `${DEPENDABOT_FILE} has no "${DEPENDABOT_LOCAL_MARKER}" line; restore it with \`bun standards sync\` and keep this repository's own update blocks below it`,
    ];
  }
  const { value, problem } = parseYaml(raw, DEPENDABOT_FILE);
  if (problem !== null) {
    return [problem];
  }
  if (!(isRecord(value) && Array.isArray(value.updates))) {
    return [`${DEPENDABOT_FILE} must define an updates list`];
  }
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const target of value.updates.flatMap(updateTargets)) {
    (seen.has(target) ? repeated : seen).add(target);
  }
  return [...repeated].map(
    (target) =>
      `${DEPENDABOT_FILE} has more than one update block for ${target}; Dependabot accepts only one, so drop or merge this repository's own copy`,
  );
};

export const dependabotProblems = async (
  consumer: string,
): Promise<ReadonlyArray<string>> => {
  const retired = await retiredDependabotLayout(consumer);
  if (retired !== null) {
    return [retired];
  }
  const path = join(consumer, DEPENDABOT_FILE);
  if (!existsSync(path)) {
    return [`${DEPENDABOT_FILE} must exist; run \`bun standards sync\``];
  }
  return inspectDependabot(await readFile(path, 'utf8'));
};

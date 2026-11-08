import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isRecord } from './github-settings-parse';
import { inspectManagedPath } from './managed-files';
import {
  countMarkerLines,
  missingMarker,
  type SplitFile,
  splitAt,
} from './split-file';
import { parseYaml } from './yaml-parse';

// The split inside the `updates` list of the Dependabot config: the shared
// update blocks above the comment, the repository's own blocks below it. YAML
// stays valid because `updates` is the file's last key.
export const DEPENDABOT_FILE = '.github/dependabot.yml';
export const DEPENDABOT_LOCAL_MARKER = '  # Project-specific updates';
const MARKER_TEXT = DEPENDABOT_LOCAL_MARKER.trimStart();

type Config = {
  readonly root: Record<string, unknown>;
  readonly updates: ReadonlyArray<unknown>;
};

const readConfig = (text: string, label: string): Config | string => {
  const { value, problem } = parseYaml(text, label);
  if (problem !== null) {
    return problem;
  }
  return isRecord(value) && Array.isArray(value.updates)
    ? { root: value, updates: value.updates }
    : `${label} must define an updates list`;
};

type Checked = {
  readonly config: Config | null;
  readonly problems: ReadonlyArray<string>;
};

// The marker splits the file by lines, but YAML reads it by indentation: a line
// below the marker indented like a key of the last shared block still belongs
// to that block. So the whole file must parse to the shared blocks first, each
// exactly as the shared part alone parses it.
const checkShared = (head: string, text: string): Checked => {
  if (countMarkerLines(DEPENDABOT_LOCAL_MARKER, text) > 1) {
    return {
      config: null,
      problems: [
        `${DEPENDABOT_FILE} has more than one "${MARKER_TEXT}" line; keep only the one below the shared update blocks`,
      ],
    };
  }
  const shared = readConfig(head, `${DEPENDABOT_FILE} above "${MARKER_TEXT}"`);
  const whole = readConfig(text, DEPENDABOT_FILE);
  if (typeof shared === 'string') {
    return { config: null, problems: [shared] };
  }
  if (typeof whole === 'string') {
    return { config: null, problems: [whole] };
  }
  return {
    config: whole,
    problems: shared.updates.flatMap((block, index) =>
      isDeepStrictEqual(block, whole.updates[index])
        ? []
        : [
            `${DEPENDABOT_FILE} changes shared update block ${index + 1} below "${MARKER_TEXT}"; start each of this repository's own update blocks with "- package-ecosystem:" indented like that line, so no line continues a shared block`,
          ],
    ),
  };
};

export const DEPENDABOT_SPLIT: SplitFile = {
  rel: DEPENDABOT_FILE,
  marker: DEPENDABOT_LOCAL_MARKER,
  own: "this repository's own update blocks",
  verify: (head, text) => checkShared(head, text).problems,
};

const TRAILING_SLASH = /\/$/u;

// `infra`, `/infra`, and `/infra/` name the same directory.
const normalizeDirectory = (directory: string): string => {
  const normalized = posix.normalize(`/${directory}`);
  return normalized.length > 1
    ? normalized.replace(TRAILING_SLASH, '')
    : normalized;
};

const directoriesOf = (
  block: Record<string, unknown>,
): ReadonlyArray<string> => [
  ...(typeof block.directory === 'string' ? [block.directory] : []),
  ...(Array.isArray(block.directories)
    ? block.directories.filter(
        (directory): directory is string => typeof directory === 'string',
      )
    : []),
];

const hasInterval = (value: unknown): boolean =>
  isRecord(value) &&
  isRecord(value.schedule) &&
  typeof value.schedule.interval === 'string';

// What Dependabot needs of every update block. A block missing it is reported
// rather than left out of the overlap check.
const blockProblems = (
  block: unknown,
  index: number,
  groups: unknown,
): ReadonlyArray<string> => {
  const where = `${DEPENDABOT_FILE} update block ${index + 1}`;
  if (!isRecord(block)) {
    return [`${where} must be a mapping`];
  }
  const group = block['multi-ecosystem-group'];
  const scheduled =
    hasInterval(block) ||
    (typeof group === 'string' &&
      isRecord(groups) &&
      Object.hasOwn(groups, group) &&
      hasInterval(groups[group]));
  return [
    ...(typeof block['package-ecosystem'] === 'string'
      ? []
      : [`${where} must set package-ecosystem`]),
    ...(directoriesOf(block).length > 0
      ? []
      : [`${where} must set directory or directories`]),
    ...(scheduled
      ? []
      : [
          `${where} must set schedule.interval or join a multi-ecosystem group that sets it`,
        ]),
  ];
};

const GLOB = /[*?[{]/u;

type Target = {
  readonly ecosystem: string;
  readonly branch: string;
  readonly directories: ReadonlyArray<string>;
};

const targetOf = (block: Record<string, unknown>): Target => ({
  ecosystem: `package-ecosystem "${String(block['package-ecosystem'])}"`,
  branch:
    typeof block['target-branch'] === 'string'
      ? `, target-branch "${block['target-branch']}"`
      : '',
  directories: directoriesOf(block),
});

// The directories that more than one of `targets` updates.
const repeatedDirectories = (
  targets: ReadonlyArray<Target>,
): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const target of targets) {
    for (const directory of new Set(
      target.directories.map(normalizeDirectory),
    )) {
      (seen.has(directory) ? repeated : seen).add(directory);
    }
  }
  return [...repeated];
};

// Dependabot refuses two update blocks for the same ecosystem, directory, and
// target branch, which is what a repository's own block that repeats a shared
// one produces. Whether two directory globs overlap is not worked out here, so
// blocks that share an ecosystem and target branch must name plain directories.
const overlapProblems = (
  blocks: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<string> => {
  const groups = new Map<
    string,
    { readonly first: Target; readonly targets: Array<Target> }
  >();
  for (const target of blocks.map(targetOf)) {
    const key = `${target.ecosystem}${target.branch}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { first: target, targets: [target] });
    } else {
      group.targets.push(target);
    }
  }
  return [...groups.values()].flatMap(({ first, targets }) => {
    const { ecosystem, branch } = first;
    if (
      targets.length > 1 &&
      targets.some(({ directories }) => directories.some((d) => GLOB.test(d)))
    ) {
      return [
        `${DEPENDABOT_FILE} has more than one update block for ${ecosystem}${branch}, and one of them uses a directory glob; the CLI can't verify that globs don't overlap, so list this repository's directories explicitly`,
      ];
    }
    return repeatedDirectories(targets).map(
      (directory) =>
        `${DEPENDABOT_FILE} has more than one update block for ${ecosystem}, directory "${directory}"${branch}; Dependabot accepts only one, so drop or merge this repository's own copy`,
    );
  });
};

export const inspectDependabot = (raw: string): ReadonlyArray<string> => {
  const split = splitAt(DEPENDABOT_SPLIT, raw);
  if (split === null) {
    return [missingMarker(DEPENDABOT_SPLIT)];
  }
  const { config, problems } = checkShared(split.head, raw);
  if (config === null || problems.length > 0) {
    return problems;
  }
  const malformed = config.updates.flatMap((block, index) =>
    blockProblems(block, index, config.root['multi-ecosystem-groups']),
  );
  return malformed.length > 0
    ? malformed
    : overlapProblems(config.updates.filter(isRecord));
};

// The Dependabot layout before the config became one file: a synced base, a
// repository-owned overlay, and a merge of the two that sync generated.
const RETIRED_DEPENDABOT_BASE = '.github/dependabot.base.yml';
const RETIRED_DEPENDABOT_LOCAL = '.github/dependabot.local.yml';

// No automatic migration: the overlay's blocks are the repository's to move.
export const retiredDependabotLayout = async (
  consumer: string,
): Promise<string | null> => {
  const found = await Promise.all(
    [RETIRED_DEPENDABOT_BASE, RETIRED_DEPENDABOT_LOCAL].map(
      async (rel) => (await inspectManagedPath(join(consumer, rel))) !== null,
    ),
  );
  if (!found.includes(true)) {
    return null;
  }
  return `${RETIRED_DEPENDABOT_BASE} and ${RETIRED_DEPENDABOT_LOCAL} are retired: ${DEPENDABOT_FILE} is now one file that sync owns down to the line "${MARKER_TEXT}", with this repository's own update blocks below it. To migrate once, add that line, indented two spaces, at the end of ${DEPENDABOT_FILE}; move the update blocks from ${RETIRED_DEPENDABOT_LOCAL} below it; delete ${RETIRED_DEPENDABOT_BASE} and ${RETIRED_DEPENDABOT_LOCAL}; then run \`bun standards sync\``;
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

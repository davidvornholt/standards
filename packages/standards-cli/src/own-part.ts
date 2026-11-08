import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEPENDABOT_SPLIT } from './dependabot';
import { inspectManagedPath, type ManagedEntry } from './managed-files';
import { interposedAncestor } from './managed-path-ownership';
import {
  joinParts,
  missingMarker,
  type Split,
  type SplitFile,
  splitAt,
} from './split-file';

export const AGENTS_FILE = 'AGENTS.md';

// The last line sync writes to AGENTS.md. Sync owns everything up to and
// including it, and the repository owns its own rules below it.
export const AGENTS_LOCAL_HEADING = '## Project-specific rules';

// The files sync owns only down to a marker line.
const SPLIT_FILES: ReadonlyMap<string, SplitFile> = new Map(
  [
    {
      rel: AGENTS_FILE,
      marker: AGENTS_LOCAL_HEADING,
      own: "this repository's own rules",
    },
    DEPENDABOT_SPLIT,
  ].map((file) => [file.rel, file]),
);

export const isSplitFile = (rel: string): boolean => SPLIT_FILES.has(rel);

// Where the repository's own part of a split file goes, for messages.
export const ownPartHint = (rel: string): string | undefined => {
  const file = SPLIT_FILES.get(rel);
  return file === undefined
    ? undefined
    : `${file.own} go below "${file.marker.trimStart()}"`;
};

// Null when `rel` is not a split file or has no marker line.
export const splitManaged = (rel: string, text: string): Split | null => {
  const file = SPLIT_FILES.get(rel);
  return file === undefined ? null : splitAt(file, text);
};

export const splitAgents = (text: string): Split | null =>
  splitManaged(AGENTS_FILE, text);

const splitFile = (rel: string): SplitFile => {
  const file = SPLIT_FILES.get(rel);
  if (file === undefined) {
    throw new Error(`${rel} is not a file sync owns down to a marker line`);
  }
  return file;
};

// The consumer's copy of `rel` when it is reached without passing a link or a
// file on the way. Below one there is no copy to read; the mirror refuses or
// prunes those destinations itself.
const consumerCopy = async (
  root: string,
  rel: string,
  planned: ReadonlyMap<string, ManagedEntry>,
): Promise<ManagedEntry | null> =>
  (await interposedAncestor(root, rel, planned)) === null
    ? await inspectManagedPath(join(root, rel))
    : null;

// Puts the repository's own part of the split file `rel` under `root` below
// `head`. Through a link the own part would come from whatever the link points
// at, so a link is refused. At a directory there is no own part to read.
export const withOwnPart = async (
  rel: string,
  head: string,
  root: string,
): Promise<string> => {
  const file = splitFile(rel);
  const entry = await consumerCopy(root, rel, new Map());
  if (entry?.kind === 'symlink') {
    throw new Error(
      `${rel} is a symlink; replace it with a regular file, then re-run`,
    );
  }
  if (entry?.kind !== 'file') {
    return joinParts(head, '');
  }
  const split = splitAt(file, await readFile(entry.absolutePath, 'utf8'));
  if (split === null) {
    throw new Error(missingMarker(file));
  }
  const text = joinParts(head, split.tail);
  const problems = file.verify?.(head, text) ?? [];
  if (problems.length > 0) {
    throw new Error(problems.join('\n'));
  }
  return text;
};

// A split file other than AGENTS.md ships the head of the source's own copy;
// the source repository keeps its own part below the marker too.
export const sourceHead = async (
  rel: string,
  entry: ManagedEntry | undefined,
): Promise<string> => {
  if (entry?.kind !== 'file') {
    throw new Error(`source ${rel} must be a regular file`);
  }
  const file = splitFile(rel);
  const split = splitAt(file, await readFile(entry.absolutePath, 'utf8'));
  if (split === null) {
    throw new Error(`source ${rel} has no "${file.marker.trimStart()}" line`);
  }
  return split.head;
};

const leavingProblem = async (
  consumer: string,
  file: SplitFile,
  planned: ReadonlyMap<string, ManagedEntry>,
): Promise<string | null> => {
  const entry = await consumerCopy(consumer, file.rel, planned);
  if (entry?.kind !== 'file') {
    return null;
  }
  const own = splitAt(file, await readFile(entry.absolutePath, 'utf8'))?.tail;
  return own === undefined || own.trim() === ''
    ? null
    : `${file.rel} is no longer synced, so sync would delete it and ${file.own} below "${file.marker.trimStart()}"; to keep them, move ${file.rel} aside, re-run, then move it back as a file this repository owns, or delete them, then re-run`;
};

// A split file that leaves the payload is pruned like any other managed file,
// which would delete the repository's own part, which sync never owned.
export const leavingOwnPartProblems = async (
  consumer: string,
  leaving: ReadonlyArray<string>,
  planned: ReadonlyMap<string, ManagedEntry>,
): Promise<ReadonlyArray<string>> =>
  (
    await Promise.all(
      leaving.flatMap((rel) => {
        const file = SPLIT_FILES.get(rel);
        return file === undefined
          ? []
          : [leavingProblem(consumer, file, planned)];
      }),
    )
  ).filter((problem): problem is string => problem !== null);

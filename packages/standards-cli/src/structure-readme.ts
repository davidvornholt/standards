import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readJsonFile } from './json-file';
import type { StructureProfile } from './structure-profile';

const SYNC_MANIFEST = 'sync-standards.json';
const TRAILING_SLASHES = /\/+$/u;
const MANIFEST_REQUIREMENT = `${SYNC_MANIFEST}: must contain a JSON object with a "paths" array of strings; the structure gate reads it to tell canonical workspaces from repo-owned ones`;

type CanonicalRels = {
  readonly rels: ReadonlySet<string>;
  readonly problem: string | null;
};

// Canonical workspaces are synced from the standards template and cannot be
// fixed in a consumer checkout, so the consumer profile exempts them from
// repo-owned documentation rules. The source repository owns those workspaces,
// so the source profile exempts nothing.
const canonicalWorkspaceRels = async (
  consumer: string,
  profile: StructureProfile,
): Promise<CanonicalRels> => {
  if (profile === 'source') {
    return { rels: new Set(), problem: null };
  }
  const manifest = await readJsonFile(join(consumer, SYNC_MANIFEST));
  const paths = manifest?.paths;
  if (
    !(
      Array.isArray(paths) &&
      paths.every((path): path is string => typeof path === 'string')
    )
  ) {
    return { rels: new Set(), problem: MANIFEST_REQUIREMENT };
  }
  return {
    rels: new Set(paths.map((path) => path.replace(TRAILING_SLASHES, ''))),
    problem: null,
  };
};

const readmeProblem = async (
  consumer: string,
  rel: string,
): Promise<string | null> => {
  const raw = await readFile(join(consumer, rel, 'README.md'), 'utf8').catch(
    () => null,
  );
  return raw !== null && raw.trim() !== ''
    ? null
    : `${rel}: repo-owned workspace must have a non-empty README.md documenting the configuration and secrets it consumes`;
};

export const collectWorkspaceReadmeProblems = async (
  consumer: string,
  profile: StructureProfile,
  rels: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> => {
  const canonical = await canonicalWorkspaceRels(consumer, profile);
  if (canonical.problem !== null) {
    // Without the manifest the gate cannot tell canonical workspaces from
    // repo-owned ones, so it fails on the manifest instead of guessing.
    return [canonical.problem];
  }
  const problems = await Promise.all(
    rels
      .filter((rel) => !canonical.rels.has(rel))
      .map((rel) => readmeProblem(consumer, rel)),
  );
  return problems.filter((problem): problem is string => problem !== null);
};

// Monorepo structure gate: enumerates workspaces from the root package.json
// `workspaces` globs and enforces the root script contract plus the
// per-workspace rules in structure-workspace.ts.

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from './github-settings';
import { inspectWorkspace, type Workspace } from './structure-workspace';

const ROOT_CHECK = 'turbo run lint check-types test build test:a11y';
const ROOT_CHECK_FIX = 'turbo run lint:fix check-types test build test:a11y';
const ROOT_A11Y = 'turbo run test:a11y';

// Root scripts with their own fixed contract; every other root script must be
// a filtered Turbo convenience alias.
const ROOT_FIXED_SCRIPTS = new Set([
  'standards',
  'check',
  'check:fix',
  'test:a11y',
]);

const GLOB_SUFFIX = '/*';

const readJson = async (
  path: string,
): Promise<Record<string, unknown> | null> => {
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

type ResolvedPattern = {
  readonly dirs: ReadonlyArray<string>;
  readonly problem: string | null;
};

// Workspace globs in this system are directory-level: a literal path or one
// trailing `/*`. Anything more exotic is itself a structure problem.
const resolvePattern = async (
  consumer: string,
  pattern: string,
): Promise<ResolvedPattern> => {
  if (
    pattern.endsWith(GLOB_SUFFIX) &&
    !pattern.slice(0, -GLOB_SUFFIX.length).includes('*')
  ) {
    const base = pattern.slice(0, -GLOB_SUFFIX.length);
    const entries = await readdir(join(consumer, base), {
      withFileTypes: true,
    }).catch(() => []);
    return {
      dirs: entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${base}/${entry.name}`),
      problem: null,
    };
  }
  if (pattern.includes('*')) {
    return {
      dirs: [],
      problem: `package.json: unsupported workspaces pattern "${pattern}"; use "<dir>/*" or a literal path`,
    };
  }
  return { dirs: [pattern], problem: null };
};

type LoadedWorkspace = {
  readonly workspace: Workspace | null;
  readonly problem: string | null;
};

// Directories without a package.json are not workspaces (Bun ignores them);
// a present but unparsable manifest is a problem, not a silent skip.
const loadWorkspace = async (
  consumer: string,
  rel: string,
): Promise<LoadedWorkspace> => {
  const path = join(consumer, rel, 'package.json');
  if (!existsSync(path)) {
    return { workspace: null, problem: null };
  }
  const manifest = await readJson(path);
  if (manifest === null) {
    return {
      workspace: null,
      problem: `${rel}: package.json must contain a JSON object`,
    };
  }
  return {
    workspace: { rel, dir: join(consumer, rel), manifest },
    problem: null,
  };
};

const inspectRootScripts = (
  root: Record<string, unknown>,
  requireA11y: boolean,
): ReadonlyArray<string> => {
  const scripts = isRecord(root.scripts) ? root.scripts : {};
  const expectations: ReadonlyArray<readonly [string, string]> = [
    ['check', ROOT_CHECK],
    ['check:fix', ROOT_CHECK_FIX],
    ...(requireA11y ? [['test:a11y', ROOT_A11Y] as const] : []),
  ];
  const gateProblems = expectations.flatMap(([name, fragment]) => {
    const { [name]: script } = scripts;
    return typeof script === 'string' && script.includes(fragment)
      ? []
      : [`package.json: root script "${name}" must run ${fragment}`];
  });
  const aliasProblems = Object.entries(scripts).flatMap(([name, script]) =>
    ROOT_FIXED_SCRIPTS.has(name) ||
    typeof script !== 'string' ||
    (script.includes('turbo run') && script.includes('--filter'))
      ? []
      : [
          `package.json: root script "${name}" must delegate through Turbo with an explicit --filter`,
        ],
  );
  return [...gateProblems, ...aliasProblems];
};

export const collectStructureProblems = async (
  consumer: string,
): Promise<ReadonlyArray<string>> => {
  const root = await readJson(join(consumer, 'package.json'));
  if (root === null) {
    return ['package.json must exist and contain a JSON object'];
  }
  const patterns = Array.isArray(root.workspaces)
    ? root.workspaces.filter(
        (pattern): pattern is string => typeof pattern === 'string',
      )
    : [];
  const resolved = await Promise.all(
    patterns.map((pattern) => resolvePattern(consumer, pattern)),
  );
  const rels = [...new Set(resolved.flatMap((r) => r.dirs))].sort();
  const loaded = await Promise.all(
    rels.map((rel) => loadWorkspace(consumer, rel)),
  );
  const workspaces = loaded.flatMap((l) =>
    l.workspace === null ? [] : [l.workspace],
  );
  const workspaceNames = new Set(
    workspaces
      .map((ws) => ws.manifest.name)
      .filter((name): name is string => typeof name === 'string'),
  );
  const inspections = await Promise.all(
    workspaces.map((ws) => inspectWorkspace(ws, workspaceNames)),
  );
  const requireA11y = inspections.some((i) => i.hasA11ySuite);
  return [
    ...resolved.flatMap((r) => (r.problem === null ? [] : [r.problem])),
    ...loaded.flatMap((l) => (l.problem === null ? [] : [l.problem])),
    ...inspectRootScripts(root, requireA11y),
    ...inspections.flatMap((i) => [...i.problems]),
  ];
};

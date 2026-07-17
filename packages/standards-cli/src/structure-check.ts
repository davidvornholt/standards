import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isRecord } from './github-settings-parse';
import {
  missingPublishedCliProblems,
  rootScriptExpectations,
  type StructureProfile,
} from './structure-profile';
import { hasSafeCommands, isSafeFilteredTurboAlias } from './structure-script';
import { inspectWorkspace, type Workspace } from './structure-workspace';

const ROOT_FIXED_SCRIPTS = new Set(
  'standards,check,check:fix,test:a11y'.split(','),
);
const GLOB_SUFFIX = '/*';
const WORKSPACES_REQUIREMENT =
  'package.json: "workspaces" must be a non-empty array of literal paths or one-level "<dir>/*" patterns';

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
type WorkspacePatterns = {
  readonly patterns: ReadonlyArray<string>;
  readonly problems: ReadonlyArray<string>;
};
const isSafeWorkspacePath = (pattern: string): boolean =>
  pattern.trim() !== '' &&
  pattern === pattern.trim() &&
  !isAbsolute(pattern) &&
  !pattern.includes('\\') &&
  pattern
    .split('/')
    .every((part) => part !== '' && part !== '.' && part !== '..');
const workspacePatternsOf = (
  root: Record<string, unknown>,
): WorkspacePatterns => {
  const { workspaces } = root;
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    return { patterns: [], problems: [WORKSPACES_REQUIREMENT] };
  }
  const patterns: Array<string> = [];
  const problems: Array<string> = [];
  workspaces.forEach((pattern, index) => {
    if (typeof pattern !== 'string') {
      problems.push(`package.json: workspaces[${index}] must be a string`);
    } else if (isSafeWorkspacePath(pattern)) {
      patterns.push(pattern);
    } else {
      problems.push(
        `package.json: unsafe workspaces pattern "${pattern}"; use a relative path without "." or ".." segments`,
      );
    }
  });
  return { patterns, problems };
};
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
    }).catch((error: unknown) =>
      isRecord(error) && error.code === 'ENOENT' ? [] : null,
    );
    if (entries === null) {
      return {
        dirs: [],
        problem: `package.json: cannot read workspace directory "${base}" declared by "${pattern}"`,
      };
    }
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
  profile: StructureProfile,
  requireA11y: boolean,
): ReadonlyArray<string> => {
  const scripts = isRecord(root.scripts) ? root.scripts : {};
  const expectations = rootScriptExpectations(profile, requireA11y);
  const gateProblems = expectations.flatMap(({ name, commands, exact }) => {
    const { [name]: script } = scripts;
    const requirement = commands.join(' && ');
    return typeof script === 'string' &&
      hasSafeCommands(script, commands, exact)
      ? []
      : [
          `package.json: root script "${name}" must run ${exact ? 'exactly ' : ''}${requirement}`,
        ];
  });
  const aliasProblems = Object.entries(scripts).flatMap(([name, script]) =>
    ROOT_FIXED_SCRIPTS.has(name) ||
    typeof script !== 'string' ||
    isSafeFilteredTurboAlias(script)
      ? []
      : [
          `package.json: root script "${name}" must delegate through Turbo with an explicit --filter`,
        ],
  );
  return [...gateProblems, ...aliasProblems];
};
export const collectStructureProblems = async (
  consumer: string,
  profile: StructureProfile,
): Promise<ReadonlyArray<string>> => {
  const root = await readJson(join(consumer, 'package.json'));
  if (root === null) {
    return ['package.json must exist and contain a JSON object'];
  }
  const declaration = workspacePatternsOf(root);
  const resolved = await Promise.all(
    declaration.patterns.map((pattern) => resolvePattern(consumer, pattern)),
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
    workspaces.map((ws) => inspectWorkspace(ws, workspaceNames, profile)),
  );
  const requireA11y = inspections.some((i) => i.hasA11ySuite);
  return [
    ...declaration.problems,
    ...resolved.flatMap((r) => (r.problem === null ? [] : [r.problem])),
    ...loaded.flatMap((l) => (l.problem === null ? [] : [l.problem])),
    ...missingPublishedCliProblems(profile, workspaces),
    ...inspectRootScripts(root, profile, requireA11y),
    ...inspections.flatMap((i) => [...i.problems]),
  ];
};

// Per-workspace monorepo structure rules, mechanized from the AGENTS.md
// contract: canonical script shapes, internal versioning, workspace:* internal
// dependencies, public `exports`, shared tsconfig inheritance, and browser
// a11y wiring. Pure data in, problems out; printing stays in cli.ts.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from './github-settings';

export type Workspace = {
  readonly rel: string;
  readonly dir: string;
  readonly manifest: Record<string, unknown>;
};

export type WorkspaceInspection = {
  readonly problems: ReadonlyArray<string>;
  readonly hasA11ySuite: boolean;
};

// Script name -> command fragment the script must contain. `test:a11y` is
// checked separately because its presence is conditional on a browser suite.
const WORKSPACE_SCRIPTS: ReadonlyArray<readonly [string, string]> = [
  ['check-types', 'tsc --noEmit'],
  ['lint', 'biome check --error-on-warnings'],
  ['lint:fix', 'biome check --write --error-on-warnings'],
  ['test', 'bun test'],
];

const A11Y_DEPENDENCIES: ReadonlyArray<string> = [
  '@axe-core/playwright',
  '@playwright/test',
];

const DEPENDENCY_FIELDS: ReadonlyArray<string> = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

// The shared config package is the definition point the inheritance rule
// protects; it cannot extend itself.
const SHARED_TSCONFIG_PACKAGE = '@davidvornholt/typescript-config';

// Raw-text match instead of JSON.parse: tsconfig.json is JSONC and only the
// `extends` target matters here.
const TSCONFIG_EXTENDS = /"extends"\s*:\s*"[^"]*typescript-config/u;

const SCAN_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.turbo',
  'dist',
  '.next',
]);

const scriptOf = (
  manifest: Record<string, unknown>,
  name: string,
): string | null => {
  const { scripts } = manifest;
  if (!isRecord(scripts)) {
    return null;
  }
  const { [name]: script } = scripts;
  return typeof script === 'string' ? script : null;
};

const isA11ySuiteFile = (name: string): boolean =>
  name.startsWith('playwright.config.') || name.endsWith('.a11y.ts');

const containsA11ySuite = async (dir: string): Promise<boolean> => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  if (entries.some((entry) => entry.isFile() && isA11ySuiteFile(entry.name))) {
    return true;
  }
  const nested = await Promise.all(
    entries
      .filter(
        (entry) => entry.isDirectory() && !SCAN_IGNORED_DIRS.has(entry.name),
      )
      .map((entry) => containsA11ySuite(join(dir, entry.name))),
  );
  return nested.includes(true);
};

const inspectScripts = (ws: Workspace): ReadonlyArray<string> =>
  WORKSPACE_SCRIPTS.flatMap(([name, fragment]) => {
    const script = scriptOf(ws.manifest, name);
    return script?.includes(fragment) === true
      ? []
      : [`${ws.rel}: script "${name}" must run ${fragment}`];
  });

const declaredDependencies = (
  manifest: Record<string, unknown>,
): ReadonlyArray<readonly [string, unknown]> =>
  DEPENDENCY_FIELDS.flatMap((field) => {
    const deps = manifest[field];
    return isRecord(deps) ? Object.entries(deps) : [];
  });

const inspectInternalDeps = (
  ws: Workspace,
  workspaceNames: ReadonlySet<string>,
): ReadonlyArray<string> =>
  declaredDependencies(ws.manifest).flatMap(([name, spec]) =>
    workspaceNames.has(name) && spec !== 'workspace:*'
      ? [`${ws.rel}: internal dependency "${name}" must use "workspace:*"`]
      : [],
  );

const inspectTsconfig = async (
  ws: Workspace,
): Promise<ReadonlyArray<string>> => {
  if (ws.manifest.name === SHARED_TSCONFIG_PACKAGE) {
    return [];
  }
  const raw = await readFile(join(ws.dir, 'tsconfig.json'), 'utf8').catch(
    () => null,
  );
  if (raw === null || !TSCONFIG_EXTENDS.test(raw)) {
    return [`${ws.rel}: tsconfig.json must extend ${SHARED_TSCONFIG_PACKAGE}`];
  }
  return [];
};

const inspectA11y = async (
  ws: Workspace,
): Promise<{ problems: ReadonlyArray<string>; hasSuite: boolean }> => {
  const hasSuite = await containsA11ySuite(ws.dir);
  if (!hasSuite) {
    return { problems: [], hasSuite };
  }
  const declared = new Set(
    declaredDependencies(ws.manifest).map(([name]) => name),
  );
  const problems = [
    ...(scriptOf(ws.manifest, 'test:a11y') === null
      ? [`${ws.rel}: a browser a11y suite requires a "test:a11y" script`]
      : []),
    ...A11Y_DEPENDENCIES.filter((dep) => !declared.has(dep)).map(
      (dep) =>
        `${ws.rel}: a browser a11y suite requires a direct dependency on ${dep}`,
    ),
  ];
  return { problems, hasSuite };
};

export const inspectWorkspace = async (
  ws: Workspace,
  workspaceNames: ReadonlySet<string>,
): Promise<WorkspaceInspection> => {
  const [tsconfigProblems, a11y] = await Promise.all([
    inspectTsconfig(ws),
    inspectA11y(ws),
  ]);
  const problems = [
    ...inspectScripts(ws),
    ...(ws.manifest.version === '0.0.0'
      ? []
      : [`${ws.rel}: internal workspace version must be "0.0.0"`]),
    ...inspectInternalDeps(ws, workspaceNames),
    ...(ws.rel.startsWith('packages/') && ws.manifest.exports === undefined
      ? [`${ws.rel}: package must define its public API with "exports"`]
      : []),
    ...tsconfigProblems,
    ...a11y.problems,
  ];
  return { problems, hasA11ySuite: a11y.hasSuite };
};

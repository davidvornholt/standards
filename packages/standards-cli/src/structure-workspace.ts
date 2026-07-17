import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from './github-settings-parse';
import {
  inspectVersionAndExports,
  type StructureProfile,
} from './structure-profile';
import { hasSafeCommand, parseSafeCommands } from './structure-script';
export type Workspace = {
  readonly rel: string;
  readonly dir: string;
  readonly manifest: Record<string, unknown>;
};
const WORKSPACE_SCRIPTS: ReadonlyArray<readonly [string, string]> = [
  ['check-types', 'tsc --noEmit'],
  ['lint', 'biome check --error-on-warnings .'],
  ['lint:fix', 'biome check --write --error-on-warnings .'],
  ['test', 'bun test'],
];
const A11Y_DEPENDENCIES = ['@axe-core/playwright', '@playwright/test'] as const;
const DEPENDENCY_FIELDS =
  'dependencies devDependencies peerDependencies optionalDependencies'.split(
    ' ',
  );
const SHARED_TSCONFIG_PACKAGE = '@davidvornholt/typescript-config';
const SHARED_TSCONFIG_PATH =
  /^@davidvornholt\/typescript-config\/(?:base|next|react-library)$/u;
const NON_EXECUTING_A11Y_OPTION =
  /^(?:-h|-V|--(?:debug|help|last-failed|list|only-changed|ui|version))(?:=|$)/u;
const IGNORED_DIRS = new Set('.git,.next,.turbo,dist,node_modules'.split(','));
const scriptOf = (
  manifest: Record<string, unknown>,
  name: string,
): string | null => {
  const scripts = isRecord(manifest.scripts) ? manifest.scripts : {};
  const script = scripts[name];
  return typeof script === 'string' ? script : null;
};
const hasSafeA11yCommand = (script: string | null): boolean =>
  parseSafeCommands(script)?.some(
    (tokens) =>
      tokens[0] === 'playwright' &&
      tokens[1] === 'test' &&
      tokens.slice(2).every((token) => !NON_EXECUTING_A11Y_OPTION.test(token)),
  ) ?? false;
const containsA11ySuite = async (dir: string): Promise<boolean> => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  if (
    entries.some((entry) => entry.isFile() && entry.name.endsWith('.a11y.ts'))
  ) {
    return true;
  }
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !IGNORED_DIRS.has(entry.name))
      .map((entry) => containsA11ySuite(join(dir, entry.name))),
  );
  return nested.includes(true);
};
const inspectScripts = (ws: Workspace): ReadonlyArray<string> =>
  WORKSPACE_SCRIPTS.flatMap(([name, command]) =>
    hasSafeCommand(scriptOf(ws.manifest, name), command)
      ? []
      : [`${ws.rel}: script "${name}" must run ${command}`],
  );
const declaredDependencies = (manifest: Record<string, unknown>) =>
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
const isSharedTsconfigPath = (value: unknown): value is string =>
  typeof value === 'string' && SHARED_TSCONFIG_PATH.test(value);
const extendsSharedTsconfig = (raw: string): boolean => {
  let parsed: unknown;
  try {
    parsed = globalThis.Bun.JSONC.parse(raw);
  } catch {
    return false;
  }
  if (!isRecord(parsed)) {
    return false;
  }
  const extensions = Array.isArray(parsed.extends)
    ? parsed.extends
    : [parsed.extends];
  return (
    extensions.every((value) => typeof value === 'string') &&
    extensions.some(isSharedTsconfigPath)
  );
};
const inspectTsconfig = async (
  ws: Workspace,
): Promise<ReadonlyArray<string>> => {
  if (ws.manifest.name === SHARED_TSCONFIG_PACKAGE) {
    return [];
  }
  const raw = await readFile(join(ws.dir, 'tsconfig.json'), 'utf8').catch(
    () => null,
  );
  if (raw === null || !extendsSharedTsconfig(raw)) {
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
    ...(hasSafeA11yCommand(scriptOf(ws.manifest, 'test:a11y'))
      ? []
      : [
          `${ws.rel}: a *.a11y.ts suite requires a non-empty "test:a11y" script that runs playwright test`,
        ]),
    ...A11Y_DEPENDENCIES.filter((dep) => !declared.has(dep)).map(
      (dep) =>
        `${ws.rel}: a *.a11y.ts suite requires a direct dependency on ${dep}`,
    ),
  ];
  return { problems, hasSuite };
};
export const inspectWorkspace = async (
  ws: Workspace,
  workspaceNames: ReadonlySet<string>,
  profile: StructureProfile,
) => {
  const [tsconfigProblems, a11y] = await Promise.all([
    inspectTsconfig(ws),
    inspectA11y(ws),
  ]);
  const problems = [
    ...inspectScripts(ws),
    ...inspectVersionAndExports(profile, ws.rel, ws.manifest),
    ...inspectInternalDeps(ws, workspaceNames),
    ...tsconfigProblems,
    ...a11y.problems,
  ];
  return { problems, hasA11ySuite: a11y.hasSuite };
};

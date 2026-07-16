import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from './github-settings';

export type Workspace = {
  readonly rel: string;
  readonly dir: string;
  readonly manifest: Record<string, unknown>;
};

const WORKSPACE_SCRIPTS: ReadonlyArray<readonly [string, string]> = [
  ['check-types', 'tsc --noEmit'],
  ['lint', 'biome check --error-on-warnings'],
  ['lint:fix', 'biome check --write --error-on-warnings'],
  ['test', 'bun test'],
];
const A11Y_DEPENDENCIES = ['@axe-core/playwright', '@playwright/test'] as const;
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;
const SHARED_TSCONFIG_PACKAGE = '@davidvornholt/typescript-config';
const UNSAFE_SCRIPT_SYNTAX = /[|;#"'`\r\n]/u;
const SCRIPT_WHITESPACE = /\s+/u;
const IGNORED_DIRS = new Set('.git,.next,.turbo,dist,node_modules'.split(','));
const scriptOf = (
  manifest: Record<string, unknown>,
  name: string,
): string | null => {
  const scripts = isRecord(manifest.scripts) ? manifest.scripts : {};
  const script = scripts[name];
  return typeof script === 'string' ? script : null;
};
const safeCommands = (
  script: string | null,
): ReadonlyArray<ReadonlyArray<string>> | null => {
  if (
    script === null ||
    script.trim() === '' ||
    UNSAFE_SCRIPT_SYNTAX.test(script) ||
    script.includes('$(')
  ) {
    return null;
  }
  const commands = script.split('&&').map((command) => command.trim());
  return commands.some((command) => command === '' || command.includes('&'))
    ? null
    : commands.map((command) => command.split(SCRIPT_WHITESPACE));
};
export const hasSafeCommand = (
  script: string | null,
  expected: string,
): boolean => {
  const commands = safeCommands(script);
  const expectedTokens = expected.split(' ');
  return (
    commands?.some((tokens) =>
      expectedTokens.every((token, index) => tokens[index] === token),
    ) ?? false
  );
};
export const isSafeFilteredTurboAlias = (script: string): boolean => {
  const commands = safeCommands(script);
  if (commands?.length !== 1) {
    return false;
  }
  const [tokens] = commands;
  const filterAt = tokens.findIndex(
    (token) => token === '--filter' || token.startsWith('--filter='),
  );
  if (tokens[0] !== 'turbo' || tokens[1] !== 'run' || filterAt <= 2) {
    return false;
  }
  const filter = tokens[filterAt];
  return filter === '--filter'
    ? tokens[filterAt + 1] !== undefined &&
        !tokens[filterAt + 1].startsWith('-')
    : filter.length > '--filter='.length;
};
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
  typeof value === 'string' &&
  (value === SHARED_TSCONFIG_PACKAGE ||
    value.startsWith(`${SHARED_TSCONFIG_PACKAGE}/`));
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
  const extension = parsed.extends;
  if (typeof extension === 'string') {
    return isSharedTsconfigPath(extension);
  }
  return (
    Array.isArray(extension) &&
    extension.every((value) => typeof value === 'string') &&
    extension.some(isSharedTsconfigPath)
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
    ...(hasSafeCommand(scriptOf(ws.manifest, 'test:a11y'), 'playwright test')
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
) => {
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

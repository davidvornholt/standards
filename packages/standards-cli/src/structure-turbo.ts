import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from './github-settings-parse';

// The root gate runs `turbo run lint` and `turbo run lint:fix`, and Turbo runs
// a root package.json script only through a task registered as `//#<name>`.
// A plain `lint` task targets workspace scripts, which no longer exist, so
// Turbo runs nothing and the gate passes without linting. A cache hit also
// skips Biome: narrowed `//#lint` inputs let CI replay main's cached pass after
// a linted file changes, and a cached `//#lint:fix` replays instead of fixing.
const ROOT_LINT_TASK = '//#lint';
const ROOT_LINT_FIX_TASK = '//#lint:fix';
const LINT_TASK_NAMES: ReadonlyArray<string> = ['lint', 'lint:fix'];
const ROOT_PACKAGE = '//';

const readTurboConfig = async (
  consumer: string,
): Promise<Record<string, unknown> | null> => {
  const raw = await readFile(join(consumer, 'turbo.json'), 'utf8').catch(
    () => null,
  );
  if (raw === null) {
    return null;
  }
  try {
    // Turbo accepts comments and trailing commas in turbo.json.
    const parsed: unknown = globalThis.Bun.JSONC.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

// Matches `lint`, `lint:fix`, and `<package>#lint(:fix)` overrides, but not
// the root `//#` tasks.
const isWorkspaceLintTask = (key: string): boolean => {
  const separator = key.lastIndexOf('#');
  const owner = separator === -1 ? null : key.slice(0, separator);
  return (
    owner !== ROOT_PACKAGE && LINT_TASK_NAMES.includes(key.slice(separator + 1))
  );
};

const rootLintProblems = (
  tasks: Record<string, unknown>,
): ReadonlyArray<string> => {
  const { [ROOT_LINT_TASK]: lint, [ROOT_LINT_FIX_TASK]: lintFix } = tasks;
  return [
    ...(isRecord(lint)
      ? []
      : [
          `turbo.json: define the root task "${ROOT_LINT_TASK}" as { "outputs": [] }; Turbo runs the root "lint" script only through that task, so without it turbo run lint never runs Biome`,
        ]),
    ...(isRecord(lint) && Object.hasOwn(lint, 'inputs')
      ? [
          `turbo.json: remove "inputs" from the root task "${ROOT_LINT_TASK}"; the default inputs cover every file Biome checks, and a narrower set replays a cached pass after a linted file changes`,
        ]
      : []),
    ...(isRecord(lintFix)
      ? []
      : [
          `turbo.json: define the root task "${ROOT_LINT_FIX_TASK}" as { "cache": false, "outputs": [] }; Turbo runs the root "lint:fix" script only through that task, so without it turbo run lint:fix never runs Biome`,
        ]),
    ...(isRecord(lintFix) && lintFix.cache !== false
      ? [
          `turbo.json: set "cache": false on the root task "${ROOT_LINT_FIX_TASK}"; a cache hit replays the previous output instead of running Biome's fixes`,
        ]
      : []),
  ];
};

export const collectTurboLintProblems = async (
  consumer: string,
): Promise<ReadonlyArray<string>> => {
  const config = await readTurboConfig(consumer);
  if (config === null) {
    return ['turbo.json must exist and contain a JSON object'];
  }
  const tasks = isRecord(config.tasks) ? config.tasks : {};
  return [
    ...rootLintProblems(tasks),
    ...Object.keys(tasks)
      .filter(isWorkspaceLintTask)
      .map(
        (key) =>
          `turbo.json: remove task "${key}"; linting runs once at the repository root through the root tasks "${ROOT_LINT_TASK}" and "${ROOT_LINT_FIX_TASK}"`,
      ),
  ];
};

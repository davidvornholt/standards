import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { isRecord } from './github-settings-parse';
import type { ManagedEntry } from './managed-files';
import { parseYaml } from './yaml-parse';

const YAML_FILE = /\.ya?ml$/u;
const ACTION = '.github/actions/sops-secret/action.yml';
const LOCAL_ACTION = './.github/actions/sops-secret';
const yamlFiles = async (root: string, rel: string): Promise<Array<string>> => {
  if (!existsSync(join(root, rel))) {
    return [];
  }
  const entries = await readdir(join(root, rel), { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          return yamlFiles(root, path);
        }
        return Promise.resolve(
          entry.isFile() && YAML_FILE.test(path) ? [path] : [],
        );
      }),
    )
  ).flat();
};
const hasLegacyCaller = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some(hasLegacyCaller);
  }
  if (!isRecord(value)) {
    return false;
  }
  return (
    (typeof value.uses === 'string' &&
      value.uses.startsWith('./') &&
      posix.resolve('/', value.uses) === posix.resolve('/', LOCAL_ACTION) &&
      isRecord(value.with) &&
      Object.hasOwn(value.with, 'env-name')) ||
    Object.values(value).some(hasLegacyCaller)
  );
};

const localActions = (value: unknown): Array<string> => {
  if (Array.isArray(value)) {
    return value.flatMap(localActions);
  }
  if (!isRecord(value)) {
    return [];
  }
  const reference = value.uses;
  return [
    ...(typeof reference === 'string' && reference.startsWith('./')
      ? [posix.normalize(reference)]
      : []),
    ...Object.values(value).flatMap(localActions),
  ];
};
const callerProblems = async (
  consumer: string,
  incoming: ReadonlyMap<string, ManagedEntry>,
): Promise<Array<string>> => {
  const visited = new Set<string>();
  const visit = async (path: string): Promise<Array<string>> => {
    if (visited.has(path)) {
      return [];
    }
    visited.add(path);
    const source = incoming.get(path)?.absolutePath ?? join(consumer, path);
    const parsed = parseYaml(await readFile(source, 'utf8'), path);
    if (parsed.problem !== null) {
      return [parsed.problem];
    }
    const problems =
      !incoming.has(path) && hasLegacyCaller(parsed.value)
        ? [
            `${path} still passes env-name to ${LOCAL_ACTION}; before syncing, give the resolver step an id, remove env-name, and pass steps.<id>.outputs.value only to each consuming step's env or action input`,
          ]
        : [];
    const nested = await Promise.all(
      localActions(parsed.value).map(async (directory) => {
        if (directory === '..' || directory.startsWith('../')) {
          return [`${path} references a local action outside the repository`];
        }
        const paths = ['action.yml', 'action.yaml']
          .map((filename) => posix.join(directory, filename))
          .filter(
            (target) =>
              incoming.has(target) || existsSync(join(consumer, target)),
          );
        return (await Promise.all(paths.map(visit))).flat();
      }),
    );
    return [...problems, ...nested.flat()];
  };
  return (
    await Promise.all((await yamlFiles(consumer, '.github')).map(visit))
  ).flat();
};

// Called before mirror writes. Consumer-owned workflows and composite actions
// are not silently rewritten, so an action interface migration must stop before
// replacing the implementation they still invoke with its retired input.
export const collectSopsActionCallerProblems = async (
  consumer: string,
  incoming: ReadonlyMap<string, ManagedEntry> = new Map(),
): Promise<ReadonlyArray<string>> => {
  const action = incoming.get(ACTION);
  const actionPath = action?.absolutePath ?? join(consumer, ACTION);
  if (
    !existsSync(actionPath) ||
    (action !== undefined && action.kind !== 'file')
  ) {
    return [];
  }
  const { value: definition } = parseYaml(
    await readFile(actionPath, 'utf8'),
    ACTION,
  );
  if (
    !(
      isRecord(definition) &&
      isRecord(definition.outputs) &&
      Object.hasOwn(definition.outputs, 'value')
    )
  ) {
    return [];
  }
  return callerProblems(consumer, incoming);
};

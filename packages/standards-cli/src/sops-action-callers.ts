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
      posix.normalize(value.uses) === posix.normalize(LOCAL_ACTION) &&
      isRecord(value.with) &&
      Object.hasOwn(value.with, 'env-name')) ||
    Object.values(value).some(hasLegacyCaller)
  );
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
  const paths = await yamlFiles(consumer, '.github');
  return (
    await Promise.all(
      paths
        .filter((path) => !incoming.has(path))
        .map(async (path) => {
          const parsed = parseYaml(
            await readFile(join(consumer, path), 'utf8'),
            path,
          );
          if (parsed.problem !== null) {
            return parsed.problem;
          }
          return hasLegacyCaller(parsed.value)
            ? `${path} still passes env-name to ${LOCAL_ACTION}; before syncing, give the resolver step an id, remove env-name, and pass steps.<id>.outputs.value only to each consuming step's env or action input`
            : null;
        }),
    )
  ).filter((problem): problem is string => problem !== null);
};

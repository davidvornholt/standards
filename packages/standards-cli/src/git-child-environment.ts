import { env } from 'node:process';

const REPOSITORY_SELECTOR_VARIABLES = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_GRAFT_FILE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_INTERNAL_SUPER_PREFIX',
  'GIT_NAMESPACE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_QUARANTINE_PATH',
  'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
]);
const COMMAND_CONFIG_VARIABLE = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u;

const isRepositorySelector = (name: string): boolean =>
  REPOSITORY_SELECTOR_VARIABLES.has(name) || COMMAND_CONFIG_VARIABLE.test(name);

export const gitChildEnvironment = (
  environment: Readonly<Record<string, string | undefined>> = env,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !isRepositorySelector(entry[0]),
    ),
  );

import { describe, expect, it } from 'bun:test';
import { gitChildEnvironment } from './git-child-environment';

const environment = (
  entries: ReadonlyArray<readonly [string, string | undefined]>,
): Readonly<Record<string, string | undefined>> => Object.fromEntries(entries);
const definedEnvironment = (
  entries: ReadonlyArray<readonly [string, string]>,
): Readonly<Record<string, string>> => Object.fromEntries(entries);

describe('Git child environment', () => {
  it('removes inherited repository selectors and command configuration', () => {
    expect(
      gitChildEnvironment(
        environment([
          ['GIT_ALTERNATE_OBJECT_DIRECTORIES', '/tmp/objects'],
          ['GIT_COMMON_DIR', '/tmp/common'],
          ['GIT_CONFIG', '/tmp/config'],
          ['GIT_CONFIG_COUNT', '1'],
          ['GIT_CONFIG_KEY_0', 'core.worktree'],
          ['GIT_CONFIG_PARAMETERS', "'core.worktree'='/tmp/worktree'"],
          ['GIT_CONFIG_VALUE_0', '/tmp/worktree'],
          ['GIT_DIR', '/tmp/repository.git'],
          ['GIT_GRAFT_FILE', '/tmp/grafts'],
          ['GIT_IMPLICIT_WORK_TREE', '0'],
          ['GIT_INDEX_FILE', '/tmp/index'],
          ['GIT_INTERNAL_SUPER_PREFIX', 'nested/'],
          ['GIT_NAMESPACE', 'namespace'],
          ['GIT_NO_REPLACE_OBJECTS', '1'],
          ['GIT_OBJECT_DIRECTORY', '/tmp/objects'],
          ['GIT_PREFIX', 'nested/'],
          ['GIT_QUARANTINE_PATH', '/tmp/quarantine'],
          ['GIT_REPLACE_REF_BASE', 'refs/replace/'],
          ['GIT_SHALLOW_FILE', '/tmp/shallow'],
          ['GIT_WORK_TREE', '/tmp/worktree'],
          ['HOME', '/home/test'],
          ['PATH', '/usr/bin'],
        ]),
      ),
    ).toEqual(
      definedEnvironment([
        ['HOME', '/home/test'],
        ['PATH', '/usr/bin'],
      ]),
    );
  });

  it('preserves ordinary process and legitimate Git configuration', () => {
    expect(
      gitChildEnvironment(
        environment([
          ['GIT_CEILING_DIRECTORIES', '/work'],
          ['GIT_CONFIG_GLOBAL', '/tmp/gitconfig'],
          ['GIT_DISCOVERY_ACROSS_FILESYSTEM', '1'],
          ['GIT_SSH_COMMAND', 'ssh -i /tmp/key'],
          ['HOME', '/home/test'],
          ['PATH', '/usr/bin'],
          ['UNDEFINED_VALUE', undefined],
        ]),
      ),
    ).toEqual(
      definedEnvironment([
        ['GIT_CEILING_DIRECTORIES', '/work'],
        ['GIT_CONFIG_GLOBAL', '/tmp/gitconfig'],
        ['GIT_DISCOVERY_ACROSS_FILESYSTEM', '1'],
        ['GIT_SSH_COMMAND', 'ssh -i /tmp/key'],
        ['HOME', '/home/test'],
        ['PATH', '/usr/bin'],
      ]),
    );
  });
});

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import {
  inspectRepositoryDirectories,
  inspectRepositoryFiles,
  openRepositoryRoot,
} from './sync-filesystem';
import { applyRepositoryMutations } from './sync-mutations';
import { requiredState } from './sync-mutations-test-helpers';

const [rootPath] = process.argv.slice(2);
if (rootPath === undefined) {
  throw new Error('Prune mount fixture requires a repository root');
}

const source = join(rootPath, '.mount-source');
const target = join(rootPath, 'legacy/unmanaged-mounted');
mkdirSync(source);
mkdirSync(target);
const mount = spawnSync('mount', ['--bind', source, target]);
if (mount.status !== 0) {
  throw new Error(`Bind mount unavailable: ${mount.stderr.toString().trim()}`);
}

let failure: unknown;
try {
  const root = await openRepositoryRoot(rootPath, 'consumer');
  const states = await inspectRepositoryFiles(root, [
    'legacy/nested/old.txt',
    'sync-standards.lock',
  ]);
  const prunes = await inspectRepositoryDirectories(root, [
    'legacy/nested',
    'legacy',
  ]);
  await applyRepositoryMutations({
    deletes: [
      {
        before: requiredState(states, 'legacy/nested/old.txt'),
        rel: 'legacy/nested/old.txt',
      },
    ],
    prunes,
    root,
    writes: [
      {
        before: requiredState(states, 'sync-standards.lock'),
        contents: Buffer.from('new lock\n'),
        mode: requiredState(states, 'sync-standards.lock').mode,
        rel: 'sync-standards.lock',
      },
    ],
  });
  const mountpoint = spawnSync('mountpoint', ['--quiet', target]);
  if (
    mountpoint.status !== 0 ||
    !existsSync(target) ||
    existsSync(join(rootPath, 'legacy/nested'))
  ) {
    throw new Error('Pruning did not preserve the unmanaged nested mount');
  }
} catch (error) {
  failure = error;
} finally {
  const unmount = spawnSync('umount', [target]);
  if (unmount.status !== 0 && failure === undefined) {
    failure = new Error('Pruning moved the unmanaged nested mount');
  }
}
if (failure !== undefined) {
  throw failure;
}

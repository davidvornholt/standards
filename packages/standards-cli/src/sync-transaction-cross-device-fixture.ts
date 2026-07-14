import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { inspectRepositoryFiles, openRepositoryRoot } from './sync-filesystem';
import { applyRepositoryMutations } from './sync-mutations';
import {
  requiredState,
  transactionArtifacts,
} from './sync-mutations-test-helpers';

const [rootPath, mode] = process.argv.slice(2);
if (
  rootPath === undefined ||
  (mode !== 'dual-mount' && mode !== 'same-device-file')
) {
  throw new Error('Mount-boundary fixture requires a repository root and mode');
}

const target = join(rootPath, 'managed/a.txt');
const mounted: Array<string> = [];
const bind = (source: string, destination: string): void => {
  const mount = spawnSync('mount', ['--bind', source, destination]);
  if (mount.status !== 0) {
    throw new Error(
      `Bind mount unavailable: ${mount.stderr.toString().trim()}`,
    );
  }
  mounted.push(destination);
};
const targetSource = join(rootPath, '.target-source');
writeFileSync(targetSource, 'bound target\n');
if (mode === 'dual-mount') {
  const parentSource = join(rootPath, '.parent-source');
  mkdirSync(parentSource);
  writeFileSync(join(parentSource, 'a.txt'), 'bound parent target\n');
  bind(parentSource, join(rootPath, 'managed'));
}
bind(targetSource, target);
if (statSync(target).dev !== statSync(rootPath).dev) {
  throw new Error('Fixture requires same-device bind mounts');
}

let unmountFailure: Error | undefined;
try {
  const root = await openRepositoryRoot(rootPath, 'consumer');
  const states = await inspectRepositoryFiles(root, [
    'managed/a.txt',
    'sync-standards.lock',
  ]);
  let journalReached = false;
  let failure: unknown;
  try {
    await applyRepositoryMutations(
      {
        deletes: [],
        prunes: [],
        root,
        writes: [
          {
            before: requiredState(states, 'managed/a.txt'),
            contents: Buffer.from('new a\n'),
            mode: requiredState(states, 'managed/a.txt').mode,
            rel: 'managed/a.txt',
          },
          {
            before: requiredState(states, 'sync-standards.lock'),
            contents: Buffer.from('new lock\n'),
            mode: requiredState(states, 'sync-standards.lock').mode,
            rel: 'sync-standards.lock',
          },
        ],
      },
      {
        afterJournal: () => {
          journalReached = true;
          return Promise.resolve();
        },
      },
    );
  } catch (error) {
    failure = error;
  }
  const expected =
    mode === 'dual-mount'
      ? 'parent: managed, target: managed/a.txt'
      : 'target: managed/a.txt';
  if (!String(failure).includes(expected)) {
    throw new Error('Existing mount boundary was not rejected', {
      cause: failure,
    });
  }
  if (journalReached || transactionArtifacts(rootPath).length > 0) {
    throw new Error('Mount preflight reached transaction publication');
  }
} finally {
  for (const destination of mounted.reverse()) {
    const unmount = spawnSync('umount', [destination]);
    if (unmount.status !== 0 && unmountFailure === undefined) {
      unmountFailure = new Error(
        `Could not unmount fixture: ${unmount.stderr}`,
      );
    }
  }
}
if (unmountFailure !== undefined) {
  throw unmountFailure;
}

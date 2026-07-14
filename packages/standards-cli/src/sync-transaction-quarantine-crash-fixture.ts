import { stat } from 'node:fs/promises';
import process from 'node:process';
import { openPinnedRoot } from './sync-directory-handles';
import { openRepositoryRoot } from './sync-filesystem';
import { bindAndRemoveEntry } from './sync-transaction-bound-remove';

const [rootPath, phase] = process.argv.slice(2);
if (rootPath === undefined || phase === undefined) {
  throw new Error('Quarantine crash fixture requires root and phase');
}
const root = await openRepositoryRoot(rootPath, 'consumer');
const directory = await openPinnedRoot(root);
const info = await stat(`${rootPath}/owned`, { bigint: true });
const terminate = (): Promise<void> => {
  process.kill(process.pid, 'SIGKILL');
  return new Promise(() => undefined);
};
await bindAndRemoveEntry({
  afterRecordPartialWrite: phase === 'partial-write' ? terminate : undefined,
  beforeBind: phase === 'before-bind' ? terminate : undefined,
  directory,
  expected: { dev: info.dev, ino: info.ino },
  kind: 'file',
  name: 'owned',
});

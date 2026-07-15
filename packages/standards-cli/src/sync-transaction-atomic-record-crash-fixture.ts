import process from 'node:process';
import { openPinnedRoot } from './sync-directory-handles';
import { openRepositoryRoot } from './sync-filesystem';
import { publishAtomicTransactionRecord } from './sync-transaction-atomic-record';

const [rootPath, finalName, phase = 'after-bind'] = process.argv.slice(2);
if (
  rootPath === undefined ||
  finalName === undefined ||
  (phase !== 'before-bind' && phase !== 'after-bind')
) {
  throw new Error(
    'Atomic record crash fixture requires a root, final name, and valid phase',
  );
}

const root = await openRepositoryRoot(rootPath, 'atomic record crash fixture');
const directory = await openPinnedRoot(root);
await publishAtomicTransactionRecord({
  afterTemporaryBind:
    phase === 'after-bind'
      ? () => {
          process.kill(process.pid, 'SIGKILL');
          return Promise.resolve();
        }
      : undefined,
  beforeTemporaryBind:
    phase === 'before-bind'
      ? () => {
          process.kill(process.pid, 'SIGKILL');
          return Promise.resolve();
        }
      : undefined,
  contents: 'owned\n',
  directory,
  finalName,
  maximumBytes: 1024,
});

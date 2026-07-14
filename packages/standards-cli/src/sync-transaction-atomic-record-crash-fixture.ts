import process from 'node:process';
import { openPinnedRoot } from './sync-directory-handles';
import { openRepositoryRoot } from './sync-filesystem';
import { publishAtomicTransactionRecord } from './sync-transaction-atomic-record';

const [rootPath, finalName] = process.argv.slice(2);
if (rootPath === undefined || finalName === undefined) {
  throw new Error('Atomic record crash fixture requires a root and final name');
}

const root = await openRepositoryRoot(rootPath, 'atomic record crash fixture');
const directory = await openPinnedRoot(root);
await publishAtomicTransactionRecord({
  afterTemporaryBind: () => {
    process.kill(process.pid, 'SIGKILL');
    return Promise.resolve();
  },
  contents: 'owned\n',
  directory,
  finalName,
  maximumBytes: 1024,
});

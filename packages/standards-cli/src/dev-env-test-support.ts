import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEV_ENV_GITIGNORE = readFileSync(
  join(import.meta.dir, '../../../template/.gitignore'),
  'utf8',
);

export const initializeDevEnvGit = (consumer: string): void => {
  execFileSync('git', ['init', '--quiet', consumer]);
  writeFileSync(join(consumer, '.gitignore'), DEV_ENV_GITIGNORE);
};

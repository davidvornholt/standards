import { resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as sleepFor } from 'node:timers/promises';
import { runDevDb } from './dev-db';

const usage = `Usage: standards dev-db <start|stop|status> [--dir <path>]

Manage the repository's local PostgreSQL container. Start reads DATABASE_URL
from <devDatabase.workspace>/.env.local (default workspace: packages/db).
Declare devDatabase.postgresVersion in the root package.json.`;

export const runDevDbCommand = async (
  argv: ReadonlyArray<string>,
  sleep: (ms: number) => Promise<unknown> = sleepFor,
): Promise<boolean> => {
  if (argv.length === 1 && ['help', '--help', '-h'].includes(argv[0] ?? '')) {
    console.log(usage);
    return true;
  }
  const [action, option, directory, ...extra] = argv;
  if (
    (action !== 'start' && action !== 'stop' && action !== 'status') ||
    (option !== undefined &&
      (option !== '--dir' || !directory || directory.startsWith('-'))) ||
    extra.length > 0
  ) {
    throw new Error(usage);
  }
  console.log(
    await runDevDb(
      resolve(directory ?? process.cwd()),
      action,
      process.env,
      sleep,
    ),
  );
  return true;
};

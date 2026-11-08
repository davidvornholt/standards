// The command edge of `standards land`: it parses the arguments, builds the
// context the land modules run in, and turns a land error into a failure.
// cli.ts hands it the process environment and output.

import { land } from './land';
import { errorMessage, POLL_SECONDS, secondsToMs } from './land-context';

const LAND_USAGE = `Usage: standards land [PR_OR_BRANCH] [--no-wait]

Wait until the checks on a pull request's current head pass, squash-merge exactly that head, and delete its local branch. A pull request that no workflow checks merges at once.

PR_OR_BRANCH is a pull request number, URL, or branch (default: the current branch's pull request).

Options:
  --no-wait  Merge without waiting for pending checks, where GitHub allows that. Use it only when the change can't affect the checks, or when no workflow reports on the pull request.

Exit code 1 means the pull request isn't merged, or that cleaning up after an earlier merge stopped. Once land merges, a cleanup problem is only a warning.`;

// Tests set LAND_POLL_SECONDS=0 to poll without delay.
const POLL_SECONDS_ENV = 'LAND_POLL_SECONDS';

const pollDelayMs = (value: string | undefined): number => {
  const seconds = value === undefined ? POLL_SECONDS : Number(value);
  if (value?.trim() === '' || !Number.isFinite(seconds) || seconds < 0) {
    throw new Error(
      `${POLL_SECONDS_ENV} must be a non-negative number of seconds: ${value}`,
    );
  }
  return secondsToMs(seconds);
};

export type LandProcess = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
};

export const runLandCommand = async (
  argv: ReadonlyArray<string>,
  edge: LandProcess,
): Promise<boolean> => {
  if (argv[0] === '-h' || argv[0] === '--help') {
    edge.out(LAND_USAGE);
    return true;
  }
  const noWait = argv.includes('--no-wait');
  const operands = argv.filter((arg) => arg !== '--no-wait');
  // Merge options such as --auto or --admin are refused, because where
  // nothing requires checks, --auto merges before CI has run.
  if (operands.length > 1 || operands[0]?.startsWith('-') === true) {
    edge.err(
      `standards land: unexpected arguments: ${operands.join(' ')}. See \`standards land --help\`.`,
    );
    return false;
  }
  try {
    const context = {
      // Resolve GitHub's repository from this checkout, even with GH_REPO set.
      env: Object.fromEntries(
        Object.entries(edge.env).filter(([key]) => key !== 'GH_REPO'),
      ),
      pollDelayMs: pollDelayMs(edge.env[POLL_SECONDS_ENV]),
      print: edge.out,
      warn: (line: string) => edge.err(`standards land: ${line}`),
    };
    await land(context, operands[0] ?? null, noWait);
    return true;
  } catch (error) {
    edge.err(`standards land: ${errorMessage(error)}`);
    return false;
  }
};

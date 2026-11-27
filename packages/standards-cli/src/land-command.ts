// The command edge of `standards land`: it parses the arguments, builds the
// context the land modules run in, and turns a land error into a failure.
// cli.ts hands it the process environment and output.

import { land } from './land';
import {
  errorMessage,
  POLL_SECONDS,
  secondsToMs,
  WAIT_SECONDS,
} from './land-context';

const LAND_USAGE = `Usage: standards land [PR_OR_BRANCH] [--no-review REASON] [--no-wait]

Wait until the checks on a pull request's current head pass, squash-merge exactly that head, and delete its local branch. A pull request that no workflow checks merges at once. It refuses an open pull request unless a review-fix report covers its current head or --no-review gives a reason.

PR_OR_BRANCH is a pull request number, URL, or branch (default: the current branch's pull request).

Options:
  --no-review REASON  Land without a review-fix report for the head, and post REASON on the pull request.
  --no-wait           Merge without waiting for pending checks, where GitHub allows that. Use it only when the change can't affect the checks, or when no workflow reports on the pull request.

Exit code 1 means the pull request isn't merged, land couldn't confirm that it is, or cleaning up after an earlier merge stopped. Once land merges, a cleanup problem is only a warning.`;

// Tests set LAND_POLL_SECONDS=0 to poll without delay, and LAND_WAIT_SECONDS
// to wait out a short limit.
const POLL_SECONDS_ENV = 'LAND_POLL_SECONDS';
const WAIT_SECONDS_ENV = 'LAND_WAIT_SECONDS';

const envMs = (
  env: LandProcess['env'],
  name: string,
  fallback: number,
): number => {
  const value = env[name];
  const seconds = value === undefined ? fallback : Number(value);
  if (value?.trim() === '' || !Number.isFinite(seconds) || seconds < 0) {
    throw new Error(
      `${name} must be a non-negative number of seconds: ${value}`,
    );
  }
  return secondsToMs(seconds);
};

const NO_REVIEW = '--no-review';
const NO_WAIT = '--no-wait';

type LandArgs = {
  readonly operands: ReadonlyArray<string>;
  readonly noWait: boolean;
  // The reason after --no-review, trimmed, or null without the flag.
  readonly noReview: string | null;
};

const parseArgs = (argv: ReadonlyArray<string>): LandArgs => {
  const at = argv.indexOf(NO_REVIEW);
  const rest =
    at === -1
      ? argv
      : argv.filter((_, index) => index !== at && index !== at + 1);
  return {
    operands: rest.filter((arg) => arg !== NO_WAIT),
    noWait: rest.includes(NO_WAIT),
    noReview: at === -1 ? null : (argv[at + 1] ?? '').trim(),
  };
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
  const { operands, noWait, noReview } = parseArgs(argv);
  if (noReview === '' || noReview?.startsWith('-') === true) {
    edge.err(
      `standards land: ${NO_REVIEW} needs a reason, such as ${NO_REVIEW} "only fixes a typo". See \`standards land --help\`.`,
    );
    return false;
  }
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
      pollDelayMs: envMs(edge.env, POLL_SECONDS_ENV, POLL_SECONDS),
      waitMs: envMs(edge.env, WAIT_SECONDS_ENV, WAIT_SECONDS),
      deadline: null,
      print: edge.out,
      warn: (line: string) => edge.err(`standards land: ${line}`),
    };
    await land(context, operands[0] ?? null, { noWait, noReview });
    return true;
  } catch (error) {
    edge.err(`standards land: ${errorMessage(error)}`);
    return false;
  }
};

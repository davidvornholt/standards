// Shared plumbing for `standards land`: the context the command edge builds,
// the error that ends a land run, and the git and gh calls every step makes.
// Only the edge in land-command.ts touches the process, so these modules take
// the child-process environment and the output functions from the context.

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export const POLL_SECONDS = 15;
// A push or ready event starts its checks within seconds, so a pull request
// that changed less than a minute ago may not show them yet.
export const QUIET_SECONDS = 60;
export const GREEN = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SHORT_SHA_LENGTH = 7;
const RUN_ID_PATTERN = /\/actions\/runs\/(?<id>\d+)\//u;

export type LandContext = {
  // The child-process environment, without GH_REPO, so gh resolves the
  // repository from this checkout.
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly pollDelayMs: number;
  readonly print: (line: string) => void;
  readonly warn: (line: string) => void;
};

export type Repository = {
  readonly url: string;
  readonly nameWithOwner: string;
  readonly defaultBranchRef: { readonly name?: string } | null;
  readonly deleteBranchOnMerge: boolean;
};

export type PullRequest = {
  readonly number: number;
  readonly url: string;
  readonly state: string;
  readonly headRefOid: string;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly isCrossRepository: boolean;
  readonly mergeCommit: { readonly oid?: string } | null;
};

export class LandError extends Error {}

export const polls = (minutes: number): number =>
  Math.floor((minutes * SECONDS_PER_MINUTE) / POLL_SECONDS);

export const shortSha = (sha: string): string => sha.slice(0, SHORT_SHA_LENGTH);

// Branch names and paths can hold spaces and newlines, so messages show them
// as JSON strings.
export const quoted = (text: string): string => JSON.stringify(text);

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const sleep = (ms: number): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

export const pollDelay = (context: LandContext): Promise<void> =>
  sleep(context.pollDelayMs);

export const secondsToMs = (seconds: number): number => seconds * MS_PER_SECOND;

export type RunResult = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
};

export const run = (
  context: LandContext,
  command: string,
  args: ReadonlyArray<string>,
  check = true,
): RunResult => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: context.env,
  });
  if (result.error !== undefined) {
    throw new LandError(`Cannot run ${command}: ${result.error.message}`);
  }
  const outcome = {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
  if (check && outcome.status !== 0) {
    throw new LandError(outcome.stderr.trim() || `${command} failed`);
  }
  return outcome;
};

// Runs a command whose progress output belongs on the terminal and reports
// whether it succeeded.
export const runVisibly = (
  context: LandContext,
  command: string,
  args: ReadonlyArray<string>,
): boolean => {
  const result = spawnSync(command, args, {
    env: context.env,
    stdio: 'inherit',
  });
  if (result.error !== undefined) {
    throw new LandError(`Cannot run ${command}: ${result.error.message}`);
  }
  return result.status === 0;
};

export const git = (
  context: LandContext,
  ...args: ReadonlyArray<string>
): string => {
  const { stdout } = run(context, 'git', args);
  return stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
};

export const ghJson = <T>(
  context: LandContext,
  ...args: ReadonlyArray<string>
): T => JSON.parse(run(context, 'gh', args).stdout) as T;

export const currentBranch = (context: LandContext): string | null => {
  const result = run(
    context,
    'git',
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    false,
  );
  return result.status === 0 ? result.stdout.trim() : null;
};

// Like Python's Path.resolve, a path that no longer exists resolves lexically.
export const resolvedPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

export const timestamp = (text: string | null | undefined): number => {
  const time = Date.parse(text ?? '');
  if (Number.isNaN(time)) {
    throw new LandError(`GitHub returned an invalid time: ${String(text)}`);
  }
  return time;
};

export const runIdOf = (detailsUrl: string | null | undefined): number => {
  const id = RUN_ID_PATTERN.exec(detailsUrl ?? '')?.groups?.id;
  return id === undefined ? 0 : Number(id);
};

export const PR_FIELDS =
  'number,url,state,headRefOid,headRefName,baseRefName,isCrossRepository,mergeCommit';

export const viewPr = <T = PullRequest>(
  context: LandContext,
  selector: string,
  repo: Repository,
  fields = PR_FIELDS,
): T =>
  ghJson<T>(
    context,
    'pr',
    'view',
    selector,
    '--repo',
    repo.url,
    '--json',
    fields,
  );

export const ownerAndName = (
  repo: Repository,
): { readonly owner: string; readonly name: string } => {
  const [owner = '', name = ''] = repo.nameWithOwner.split('/');
  return { owner, name };
};

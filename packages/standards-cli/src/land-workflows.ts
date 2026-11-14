// Whether a pull request has CI that reports on it: any workflow file that
// runs for it on a pull request event or a push of its head branch. A
// workflow that only runs on a schedule, such as the synced standards-sync
// workflow, or whose filters leave the pull request out never reports checks
// on it, so waiting for it would wait out the whole timeout.

import { isRecord } from './github-settings-parse';
import {
  type LandContext,
  ownerAndName,
  type Repository,
  run,
} from './land-context';
import { eventRuns, type TriggerTarget } from './land-triggers';
import { parseYaml } from './yaml-parse';

type CiEvent = 'pull_request' | 'pull_request_target' | 'push';

// A push-triggered run also reports on the head commit.
const CI_EVENTS: ReadonlySet<string> = new Set<CiEvent>([
  'pull_request',
  'pull_request_target',
  'push',
]);
const WORKFLOW_FILE_PATTERN = /\.ya?ml$/u;
// GitHub evaluates path filters against the first 300 changed files only.
const PATH_FILTER_FILES = 300;
const FILES_PER_PAGE = 100;
// One JSON list of names per changed file: its path and any old path.
const FILE_NAMES =
  '.[] | [.filename] + (if .previous_filename then [.previous_filename] else [] end) | tojson';

const WORKFLOWS_QUERY =
  'query($owner: String!, $name: String!, $tree: String!) { repository(owner: $owner, name: $name) ' +
  '{ workflows: object(expression: $tree) { ... on Tree { entries { name type ' +
  'object { ... on Blob { text isTruncated } } } } } } }';
const TIP_QUERY =
  'query($owner: String!, $name: String!, $ref: String!) { repository(owner: $owner, name: $name) ' +
  '{ ref(qualifiedName: $ref) { target { oid } } } }';

type WorkflowsResponse = {
  readonly data: {
    readonly repository: {
      readonly workflows: {
        readonly entries?: ReadonlyArray<{
          readonly name: string;
          readonly type: string;
          readonly object: {
            readonly text?: string | null;
            readonly isTruncated?: boolean;
          } | null;
        }>;
      } | null;
    };
  };
};

type TipResponse = {
  readonly data: {
    readonly repository: {
      readonly ref: { readonly target: { readonly oid: string } } | null;
    };
  };
};

// The events in a workflow's `on` with their filters. `on` is an event name,
// a list of them, or a map from them to their filters. Null when `on` has
// none of these shapes.
const triggerEvents = (
  on: unknown,
): ReadonlyArray<readonly [unknown, unknown]> | null => {
  if (typeof on === 'string') {
    return [[on, null]];
  }
  if (Array.isArray(on)) {
    return on.map((event) => [event, null]);
  }
  return isRecord(on) ? Object.entries(on) : null;
};

// A file that can't be read or parsed counts as CI, so an error leans toward
// waiting for checks rather than merging without them.
export const workflowTriggersCi = (
  text: string | null,
  target: TriggerTarget,
): boolean => {
  if (text === null) {
    return true;
  }
  const { value, problem } = parseYaml(text, 'workflow');
  if (problem !== null || !isRecord(value)) {
    return true;
  }
  const events = triggerEvents(value.on);
  return (
    events === null ||
    events.some(
      ([event, config]) =>
        typeof event !== 'string' ||
        (CI_EVENTS.has(event) && eventRuns(event as CiEvent, config, target)),
    )
  );
};

const workflowTexts = (
  context: LandContext,
  repo: Repository,
  sha: string,
): ReadonlyArray<string | null> => {
  const { owner, name } = ownerAndName(repo);
  // Read the files at the commit through GitHub, because the checkout may not
  // have it.
  const response = JSON.parse(
    run(context, 'gh', [
      'api',
      'graphql',
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-f',
      `tree=${sha}:.github/workflows`,
      '-f',
      `query=${WORKFLOWS_QUERY}`,
    ]).stdout,
  ) as WorkflowsResponse;
  // A commit without a workflows folder has no tree there.
  const entries = response.data.repository.workflows?.entries ?? [];
  return entries
    .filter(
      (entry) =>
        entry.type === 'blob' && WORKFLOW_FILE_PATTERN.test(entry.name),
    )
    .map((entry) =>
      entry.object?.isTruncated === true ? null : (entry.object?.text ?? null),
    );
};

// The commit a branch points to now, or null when the branch doesn't exist.
// The pull request's own baseRefOid can't stand in for it, because GitHub
// doesn't update it when the branch moves.
const branchTip = (
  context: LandContext,
  repo: Repository,
  branch: string,
): string | null => {
  const { owner, name } = ownerAndName(repo);
  const response = JSON.parse(
    run(context, 'gh', [
      'api',
      'graphql',
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-f',
      `ref=refs/heads/${branch}`,
      '-f',
      `query=${TIP_QUERY}`,
    ]).stdout,
  ) as TipResponse;
  return response.data.repository.ref?.target.oid ?? null;
};

// The paths a pull request changes, or null when there are more than path
// filters read.
const changedFiles = (
  context: LandContext,
  repo: Repository,
  prNumber: number,
): ReadonlyArray<string> | null => {
  const lines = run(context, 'gh', [
    'api',
    `repos/${repo.nameWithOwner}/pulls/${prNumber}/files?per_page=${FILES_PER_PAGE}`,
    '--paginate',
    '--jq',
    FILE_NAMES,
  ])
    .stdout.split('\n')
    .filter(Boolean);
  return lines.length >= PATH_FILTER_FILES
    ? null
    : lines.flatMap((line) => JSON.parse(line) as Array<string>);
};

// Returns a lookup that reads each commit's workflows and each head's changed
// files once, because neither changes for a commit.
export const ciDetector = (
  context: LandContext,
  repo: Repository,
  pr: { readonly number: number; readonly headRefName: string },
): ((head: string, base: string) => boolean) => {
  const texts = new Map<string, ReadonlyArray<string | null>>();
  const files = new Map<string, ReadonlyArray<string> | null>();
  const target = (head: string, base: string): TriggerTarget => ({
    base,
    head: pr.headRefName,
    changedFiles: () => {
      if (!files.has(head)) {
        files.set(head, changedFiles(context, repo, pr.number));
      }
      return files.get(head) ?? null;
    },
  });
  const commit = (sha: string, on: TriggerTarget): boolean => {
    const known = texts.get(sha) ?? workflowTexts(context, repo, sha);
    texts.set(sha, known);
    return known.some((text) => workflowTriggersCi(text, on));
  };
  // GitHub runs `pull_request` workflows from the merge of the head into the
  // base branch and `pull_request_target` workflows from the base branch, so
  // a head cut before its base gained CI still gets checks. The base branch
  // can move while land waits, so each call looks up its tip again. A base
  // branch that can't be found counts as CI.
  return (head: string, base: string): boolean => {
    const on = target(head, base);
    if (commit(head, on)) {
      return true;
    }
    const tip = branchTip(context, repo, base);
    return tip === null || commit(tip, on);
  };
};

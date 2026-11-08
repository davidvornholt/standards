// Whether a pull request has CI that reports on it: any workflow file that
// runs on pull requests or pushes. A workflow that only runs on a
// schedule, such as the synced standards-sync workflow, never reports checks,
// so waiting for it would wait out the whole timeout.

import { isRecord } from './github-settings-parse';
import {
  type LandContext,
  ownerAndName,
  type Repository,
  run,
} from './land-context';
import { parseYaml } from './yaml-parse';

// A push-triggered run also reports on the head commit.
const CI_EVENTS = new Set(['pull_request', 'pull_request_target', 'push']);
const WORKFLOW_FILE_PATTERN = /\.ya?ml$/u;

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

// The events in a workflow's `on`, which is an event name, a list of them, or
// a map keyed by them. Null when `on` has none of these shapes.
const triggerEvents = (on: unknown): ReadonlyArray<unknown> | null => {
  if (typeof on === 'string') {
    return [on];
  }
  if (Array.isArray(on)) {
    return on;
  }
  return isRecord(on) ? Object.keys(on) : null;
};

// A file that can't be read or parsed counts as CI, so an error leans toward
// waiting for checks rather than merging without them.
export const workflowTriggersCi = (text: string | null): boolean => {
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
    events.some((event) => typeof event !== 'string' || CI_EVENTS.has(event))
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

// Returns a lookup that reads each commit's workflows once, because the files
// at a commit never change.
export const ciDetector = (
  context: LandContext,
  repo: Repository,
): ((head: string, base: string) => boolean) => {
  const known = new Map<string, boolean>();
  const commit = (sha: string): boolean => {
    const cached = known.get(sha);
    if (cached !== undefined) {
      return cached;
    }
    const hasCi = workflowTexts(context, repo, sha).some(workflowTriggersCi);
    known.set(sha, hasCi);
    return hasCi;
  };
  // GitHub runs `pull_request` workflows from the merge of the head into the
  // base branch and `pull_request_target` workflows from the base branch, so
  // a head cut before its base gained CI still gets checks. The base branch
  // can move while land waits, so each call looks up its tip again. A base
  // branch that can't be found counts as CI.
  return (head: string, base: string): boolean => {
    if (commit(head)) {
      return true;
    }
    const tip = branchTip(context, repo, base);
    return tip === null || commit(tip);
  };
};

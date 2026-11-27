// A fake `gh` for the land suites. The bin/gh shim that land-test-support.ts
// writes runs fakeGh with the arguments and environment it got, so this module
// never reads process state. GitHub's side lives in two JSON files the test writes
// before each run: the pull request (GH_FIXTURE) and the rest (GH_GITHUB).
// Every call is appended to GH_CALLS as a JSON array of its arguments.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import {
  failure,
  graphql,
  json,
  nextOf,
  ok,
} from './land-fake-gh-graphql-test-support';

const SHA_LENGTH = 40;
const MERGE_COMMIT = 'f'.repeat(SHA_LENGTH);
const UNKNOWN_CALL = 99;
const MILLISECONDS = /\.\d+Z$/u;
const INT32_BYTES = 4;
// How land asks whether the base branch, trunk, contains a commit.
const ON_BASE = /\/compare\/(?<commit>[0-9a-f]+)\.\.\.trunk$/u;

type FakeFile = {
  filename: string;
  // biome-ignore lint/style/useNamingConvention: GitHub's REST field.
  previous_filename?: string;
};

export type FakePr = Record<string, unknown> & {
  // The changed files, as GitHub's REST API lists them.
  files: Array<FakeFile>;
  // Each poll of the checks applies the next entry; the last one stays.
  polls: Array<Record<string, unknown>>;
  // The pull request's comments, oldest first. A bare body is the owner's.
  comments: Array<string | { readonly author: string; readonly body: string }>;
};

export type FakeGithub = {
  // False when the commit has no workflows folder.
  workflows: boolean;
  // Makes reading the workflow files fail.
  workflowsFail: boolean;
  compare: string | null;
  // Each lookup of how many commits the pull request's head lacks from its
  // base applies the next entry; the last one stays.
  behindBy: Array<number>;
  // The time of the last ready-for-review event, which `gh pr ready` sets.
  ready: string | null;
  // Maps a check's run to its workflow file.
  runFiles: Record<string, string>;
  // Maps a check's run to the event that started it, pull_request if absent.
  runEvents: Record<string, string>;
  // Workflow file texts by path, at every commit.
  workflowFiles: Record<string, string>;
  // Workflow file texts by path at the commits listed here, in place of
  // workflowFiles.
  commitWorkflows: Record<string, Record<string, string>>;
  // Each lookup of the base branch's tip applies the next entry; the last one
  // stays. Empty when the branch doesn't exist.
  baseTips: Array<string>;
  // The checks that rulesets and classic branch protection require on every
  // branch.
  rulesetChecks: Array<string>;
  protectionChecks: Array<string>;
  // Each lookup of the workflow runs on the pull request's head applies the
  // next entry; the last one stays.
  workflowRuns: Array<Array<FakeRun>>;
  // The parents of the commits listed here, first parent first. Other commits
  // have one parent.
  parents: Record<string, Array<string>>;
  // Commits in the base branch's history.
  onBase: Array<string>;
  // The login of the account gh is signed in to.
  viewer: string;
};

export type FakeRun = {
  readonly name: string;
  readonly event: string;
  readonly status: string;
  // biome-ignore lint/style/useNamingConvention: GitHub's REST field.
  readonly head_branch: string;
  // biome-ignore lint/style/useNamingConvention: GitHub's REST field.
  readonly updated_at: string;
};

type Env = Readonly<Record<string, string | undefined>>;

export type FakeGhResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
};

export type Call = {
  readonly args: ReadonlyArray<string>;
  readonly env: Env;
  readonly pr: FakePr;
  readonly github: FakeGithub;
  readonly savePr: () => void;
  readonly saveGithub: () => void;
};

const notFound = (): FakeGhResult => failure('gh: Not Found (HTTP 404)\n');

// A poll whose entry sets hangMs answers only after that long, like a gh
// call that hangs.
const viewPr = ({ args, pr, savePr }: Call): FakeGhResult => {
  // After a merge, the next readBackFailures reads fail, like an API outage.
  const failures = Number(pr.readBackFailures ?? 0);
  if (pr.mergeRequested === true && failures > 0) {
    pr.readBackFailures = failures - 1;
    savePr();
    return failure('HTTP 503: read-back unavailable\n');
  }
  if ((args.at(-1) ?? '').includes('statusCheckRollup')) {
    const poll = nextOf(pr.polls);
    if (poll !== undefined) {
      Object.assign(pr, poll);
      savePr();
    }
    const hangMs = Number(pr.hangMs ?? 0);
    if (hangMs > 0) {
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(INT32_BYTES)),
        0,
        0,
        hangMs,
      );
    }
  }
  // No field that land views holds the comments.
  return json({ ...pr, comments: undefined });
};

const markReady = ({ pr, github, savePr, saveGithub }: Call): FakeGhResult => {
  pr.isDraft = false;
  savePr();
  github.ready = new Date().toISOString().replace(MILLISECONDS, 'Z');
  saveGithub();
  return ok();
};

const merge = ({ env, pr, savePr }: Call): FakeGhResult => {
  if (env.GH_MERGE_FAIL) {
    return failure('');
  }
  pr.mergeRequested = true;
  // Like gh when GitHub merges but its response is cut off.
  if (env.GH_MERGE_EOF) {
    Object.assign(pr, { state: 'MERGED', mergeCommit: { oid: MERGE_COMMIT } });
    savePr();
    return failure('EOF\n');
  }
  // A pull request that only joins a merge queue stays open.
  if (pr.queued === true) {
    savePr();
    return ok('Added pull request to merge queue.\n');
  }
  Object.assign(pr, { state: 'MERGED', mergeCommit: { oid: MERGE_COMMIT } });
  savePr();
  return ok();
};

const compare = ({ args, env, github, saveGithub }: Call): FakeGhResult => {
  if (args.includes('.behind_by')) {
    if (env.GH_BEHIND_FAIL) {
      return failure('GitHub unavailable\n');
    }
    const behind = nextOf(github.behindBy) ?? 0;
    saveGithub();
    return ok(`${behind}\n`);
  }
  const commit = ON_BASE.exec(args[1] ?? '')?.groups?.commit;
  if (commit !== undefined) {
    return ok(`${github.onBase.includes(commit) ? 'ahead' : 'diverged'}\n`);
  }
  return github.compare === null ? notFound() : ok(`${github.compare}\n`);
};

// land asks gh's --jq for one JSON array of names per file.
const prFiles = ({ pr }: Call): FakeGhResult =>
  ok(
    `${pr.files
      .map((file) =>
        JSON.stringify(
          file.previous_filename === undefined
            ? [file.filename]
            : [file.filename, file.previous_filename],
        ),
      )
      .join('\n')}\n`,
  );

// land asks gh's --jq for each comment line with "Reviewed through " and its
// author, as one JSON object per line.
const prComments = ({ pr }: Call): FakeGhResult =>
  ok(
    pr.comments
      .flatMap((comment) => {
        const { author, body } =
          typeof comment === 'string'
            ? { author: 'test', body: comment }
            : comment;
        return body
          .split('\n')
          .filter((line) => line.includes('Reviewed through '))
          .map((line) => `${JSON.stringify({ author, line })}\n`);
      })
      .join(''),
  );

const addComment = ({ args, pr, savePr }: Call): FakeGhResult => {
  pr.comments.push(args[args.indexOf('--body') + 1] ?? '');
  savePr();
  return ok();
};

const branchRules = ({ github }: Call): FakeGhResult =>
  json([
    { type: 'deletion' },
    {
      type: 'required_status_checks',
      parameters: {
        // biome-ignore lint/style/useNamingConvention: GitHub's REST field.
        required_status_checks: github.rulesetChecks.map((context) => ({
          context,
          // biome-ignore lint/style/useNamingConvention: GitHub's REST field.
          integration_id: 1,
        })),
      },
    },
  ]);

const branch = ({ github }: Call): FakeGhResult => {
  const required = github.protectionChecks;
  return json({
    name: 'trunk',
    protected: true,
    protection: {
      enabled: required.length > 0,
      // biome-ignore lint/style/useNamingConvention: GitHub's REST field.
      required_status_checks: {
        // biome-ignore lint/style/useNamingConvention: GitHub's REST field.
        enforcement_level: required.length > 0 ? 'everyone' : 'off',
        contexts: required,
        // biome-ignore lint/style/useNamingConvention: GitHub's REST field.
        checks: required.map((context) => ({ context, app_id: null })),
      },
    },
  });
};

// land asks gh's --jq for one JSON object per run.
const workflowRuns = ({ github, saveGithub }: Call): FakeGhResult => {
  const runs = nextOf(github.workflowRuns) ?? [];
  saveGithub();
  return ok(runs.map((run) => `${JSON.stringify(run)}\n`).join(''));
};

// land asks gh's --jq for one JSON array of the commit's parents.
const commitParents = ({ args, github }: Call): FakeGhResult =>
  json(github.parents[args[1]?.slice(-SHA_LENGTH) ?? ''] ?? [MERGE_COMMIT]);

const REST_ROUTES: ReadonlyArray<
  readonly [RegExp, (call: Call) => FakeGhResult]
> = [
  [/^repos\/[^/]+\/[^/]+\/compare\//u, compare],
  [/^repos\/[^/]+\/[^/]+\/rules\/branches\//u, branchRules],
  [/^repos\/[^/]+\/[^/]+\/branches\//u, branch],
  [/^repos\/[^/]+\/[^/]+\/pulls\/\d+\/files/u, prFiles],
  [/^repos\/[^/]+\/[^/]+\/issues\/\d+\/comments/u, prComments],
  [/^repos\/[^/]+\/[^/]+\/actions\/runs\?/u, workflowRuns],
  [/^repos\/[^/]+\/[^/]+\/commits\/[0-9a-f]{40}$/u, commitParents],
];

const repoView = ({ env }: Call): FakeGhResult =>
  json({
    url: 'https://github.com/test/repo',
    nameWithOwner: 'test/repo',
    defaultBranchRef: { name: 'trunk' },
    deleteBranchOnMerge: !env.GH_KEEPS_BRANCHES,
  });

const ROUTES: ReadonlyMap<string, (call: Call) => FakeGhResult> = new Map([
  ['repo view', repoView],
  ['pr view', viewPr],
  ['pr ready', markReady],
  ['pr update-branch', () => ok()],
  ['pr merge', merge],
  ['pr comment', addComment],
  ['api graphql', graphql],
  ['api user', ({ github }) => ok(`${github.viewer}\n`)],
]);

const route = (call: Call): FakeGhResult => {
  const handler = ROUTES.get(call.args.slice(0, 2).join(' '));
  if (handler !== undefined) {
    return handler(call);
  }
  const rest =
    call.args[0] === 'api'
      ? REST_ROUTES.find(([path]) => path.test(call.args[1] ?? ''))
      : undefined;
  if (rest !== undefined) {
    return rest[1](call);
  }
  return failure(`Unexpected gh call: ${call.args.join(' ')}\n`, UNKNOWN_CALL);
};

export const fakeGh = (args: ReadonlyArray<string>, env: Env): FakeGhResult => {
  appendFileSync(env.GH_CALLS ?? '', `${JSON.stringify(args)}\n`);
  if (env.GH_REPO !== undefined) {
    return failure('GH_REPO reached gh\n', UNKNOWN_CALL);
  }
  if (env.GH_FAIL) {
    return failure('GitHub unavailable\n');
  }
  const prPath = env.GH_FIXTURE ?? '';
  const githubPath = env.GH_GITHUB ?? '';
  const pr = JSON.parse(readFileSync(prPath, 'utf8')) as FakePr;
  const github = JSON.parse(readFileSync(githubPath, 'utf8')) as FakeGithub;
  return route({
    args,
    env,
    pr,
    github,
    savePr: () => writeFileSync(prPath, JSON.stringify(pr)),
    saveGithub: () => writeFileSync(githubPath, JSON.stringify(github)),
  });
};

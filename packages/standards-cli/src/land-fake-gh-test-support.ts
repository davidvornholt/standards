// A fake `gh` for the land suites. The bin/gh shim that installFakeGh writes
// runs fakeGh with the arguments and environment it got, so this module never
// reads process state. GitHub's side lives in two JSON files the test writes
// before each run: the pull request (GH_FIXTURE) and the rest (GH_GITHUB).
// Every call is appended to GH_CALLS as a JSON array of its arguments.

import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

export const MERGED_AT = '2026-06-01T00:00:00Z';
const SHA_LENGTH = 40;
export const MERGE_COMMIT = 'f'.repeat(SHA_LENGTH);
const EXECUTABLE = 0o755;
const UNKNOWN_CALL = 99;
const WORKFLOWS_DIR = '.github/workflows/';
const MILLISECONDS = /\.\d+Z$/u;

export type FakePr = Record<string, unknown> & {
  // Each poll of the checks applies the next entry; the last one stays.
  polls: Array<Record<string, unknown>>;
};

export type FakeRun = Readonly<Record<string, string>>;

export type FakeGithub = {
  // False when the commit has no workflows folder.
  workflows: boolean;
  // Makes reading the workflow files fail.
  workflowsFail: boolean;
  compare: string | null;
  // The time of the last ready-for-review event, which `gh pr ready` sets.
  ready: string | null;
  // Each `gh run list` applies the next entry to `runs`; the last one stays.
  runPolls: Array<Array<FakeRun>>;
  runs: Array<FakeRun>;
  // Maps a check's run to its workflow file.
  runFiles: Record<string, string>;
  // Workflow file texts by path, at every commit.
  workflowFiles: Record<string, string>;
};

type Env = Readonly<Record<string, string | undefined>>;

export type FakeGhResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
};

type Call = {
  readonly args: ReadonlyArray<string>;
  readonly env: Env;
  readonly pr: FakePr;
  readonly github: FakeGithub;
  readonly savePr: () => void;
  readonly saveGithub: () => void;
};

const ok = (stdout = ''): FakeGhResult => ({ stdout, stderr: '', status: 0 });
const json = (value: unknown): FakeGhResult => ok(`${JSON.stringify(value)}\n`);
const failure = (stderr: string, status = 1): FakeGhResult => ({
  stdout: '',
  stderr,
  status,
});
const notFound = (): FakeGhResult => failure('gh: Not Found (HTTP 404)\n');

const nextOf = <T>(queue: Array<T>): T | undefined =>
  queue.length > 1 ? queue.shift() : queue[0];

const option = (
  args: ReadonlyArray<string>,
  name: string,
  fallback: string,
): string => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};

const viewPr = ({ args, pr, savePr }: Call): FakeGhResult => {
  if ((args.at(-1) ?? '').includes('statusCheckRollup')) {
    const poll = nextOf(pr.polls);
    if (poll !== undefined) {
      Object.assign(pr, poll);
      savePr();
    }
  }
  return json(pr);
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
  Object.assign(pr, {
    state: 'MERGED',
    mergeCommit: { oid: MERGE_COMMIT },
    mergedAt: MERGED_AT,
  });
  savePr();
  return ok();
};

const runsLookup = ({ github }: Call): FakeGhResult =>
  json({
    data: {
      repository: {
        commit: {
          checkSuites: {
            nodes: [
              { workflowRun: null },
              ...Object.entries(github.runFiles).map(([run, path]) => ({
                workflowRun: { databaseId: Number(run), file: { path } },
              })),
            ],
          },
        },
        workflows: {
          entries: Object.entries(github.workflowFiles).map(([path, text]) => ({
            path,
            object: { text },
          })),
        },
      },
    },
  });

const workflowTree = ({ github }: Call): FakeGhResult => {
  if (github.workflowsFail) {
    return failure('GitHub unavailable\n');
  }
  const entries = Object.entries(github.workflowFiles)
    .filter(([path]) => path.startsWith(WORKFLOWS_DIR))
    .map(([path, text]) => ({
      name: path.slice(WORKFLOWS_DIR.length),
      type: 'blob',
      object: { text, isTruncated: false },
    }));
  return json({
    data: {
      repository: { workflows: github.workflows ? { entries } : null },
    },
  });
};

const graphql = (call: Call): FakeGhResult => {
  if (call.args.some((arg) => arg.includes('timelineItems'))) {
    return ok(`${call.github.ready ?? ''}\n`);
  }
  if (call.args.some((arg) => arg.includes('checkSuites'))) {
    return runsLookup(call);
  }
  return workflowTree(call);
};

const compare = ({ github }: Call): FakeGhResult =>
  github.compare === null ? notFound() : ok(`${github.compare}\n`);

// A run is filed under the merge commit and created at the merge unless it
// says otherwise.
const listRuns = ({ args, github, saveGithub }: Call): FakeGhResult => {
  const runs = nextOf(github.runPolls);
  if (runs !== undefined) {
    github.runs = runs;
    saveGithub();
  }
  const created = option(args, '--created', '>=').replace('>=', '');
  return json(
    github.runs.filter((run) => {
      const headSha = run.headSha ?? MERGE_COMMIT;
      return (
        option(args, '--event', run.event ?? '') === run.event &&
        option(args, '--commit', headSha) === headSha &&
        (run.createdAt ?? MERGED_AT) >= created
      );
    }),
  );
};

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
  ['api graphql', graphql],
  ['run list', listRuns],
]);

const route = (call: Call): FakeGhResult => {
  const handler = ROUTES.get(call.args.slice(0, 2).join(' '));
  if (handler !== undefined) {
    return handler(call);
  }
  if (call.args[0] === 'api' && (call.args[1] ?? '').includes('/compare/')) {
    return compare(call);
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

// Writes bin/gh under root, which runs fakeGh under the running Bun.
export const installFakeGh = (root: string): string => {
  const bin = join(root, 'bin');
  const gh = join(bin, 'gh');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    gh,
    [
      `#!${process.execPath}`,
      `import { fakeGh } from ${JSON.stringify(join(import.meta.dir, 'land-fake-gh-test-support.ts'))};`,
      'const result = fakeGh(process.argv.slice(2), process.env);',
      'process.stdout.write(result.stdout);',
      'process.stderr.write(result.stderr);',
      'process.exitCode = result.status;',
      '',
    ].join('\n'),
  );
  chmodSync(gh, EXECUTABLE);
  return bin;
};

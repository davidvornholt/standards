import type { Call, FakeGhResult } from './land-fake-gh-test-support';

const WORKFLOWS_DIR = '.github/workflows/';

export const ok = (stdout = ''): FakeGhResult => ({
  stdout,
  stderr: '',
  status: 0,
});
export const json = (value: unknown): FakeGhResult =>
  ok(`${JSON.stringify(value)}\n`);
export const failure = (stderr: string, status = 1): FakeGhResult => ({
  stdout: '',
  stderr,
  status,
});
export const nextOf = <T>(queue: Array<T>): T | undefined =>
  queue.length > 1 ? queue.shift() : queue[0];

const runsLookup = ({ github }: Call): FakeGhResult =>
  json({
    data: {
      repository: {
        commit: {
          checkSuites: {
            nodes: [
              { workflowRun: null },
              ...Object.entries(github.runFiles).map(([run, path]) => ({
                workflowRun: {
                  databaseId: Number(run),
                  event: github.runEvents[run] ?? 'pull_request',
                  file: { path },
                },
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

const workflowTree = ({ args, github }: Call): FakeGhResult => {
  if (github.workflowsFail) {
    return failure('GitHub unavailable\n');
  }
  const files =
    Object.entries(github.commitWorkflows).find(([sha]) =>
      args.includes(`tree=${sha}:.github/workflows`),
    )?.[1] ?? github.workflowFiles;
  const entries = Object.entries(files)
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

// Only the pull request's base branch exists.
const branchTip = ({ args, pr, github, saveGithub }: Call): FakeGhResult => {
  const base = `ref=refs/heads/${String(pr.baseRefName)}`;
  const tip = args.includes(base) ? nextOf(github.baseTips) : undefined;
  saveGithub();
  return json({
    data: {
      repository: { ref: tip === undefined ? null : { target: { oid: tip } } },
    },
  });
};

export const graphql = (call: Call): FakeGhResult => {
  if (call.args.some((arg) => arg.includes('qualifiedName'))) {
    return branchTip(call);
  }
  if (call.args.some((arg) => arg.includes('timelineItems'))) {
    return ok(`${call.github.ready ?? ''}\n`);
  }
  if (call.args.some((arg) => arg.includes('checkSuites'))) {
    return runsLookup(call);
  }
  return workflowTree(call);
};

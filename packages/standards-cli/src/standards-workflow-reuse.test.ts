import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { parse } from 'yaml';
import { cleanupTmpDirs } from './cli-test-support';
import {
  type Json,
  runStepWithApi,
  WORKFLOW,
} from './standards-workflow-test-support';

const PROOF_STEP = 'Prove a validated pull request result';
const SHA_LENGTH = 40;
const RUN_ID = 12;
const OTHER_RUN_ID = 13;
const CHECK_RUN_ID = 34;
const OTHER_CHECK_RUN_ID = 35;
const REPOSITORY = 'owner/repo';
const FORK = 'contributor/repo';
const SHA = 'a'.repeat(SHA_LENGTH);
const HEAD = 'b'.repeat(SHA_LENGTH);
const TREE = 'c'.repeat(SHA_LENGTH);
const MERGED_AT = '2026-10-10T12:00:00Z';
const TREE_TITLE = 'Standards validated tree';

const proofEnvironment = (): Record<string, string> => {
  const workflow = parse(readFileSync(WORKFLOW, 'utf8')) as {
    jobs: {
      reuse: { steps: Array<{ name?: string; env?: Record<string, string> }> };
    };
  };
  const env = workflow.jobs.reuse.steps.find(
    (step) => step.name === PROOF_STEP,
  )?.env;
  if (env === undefined) {
    throw new Error(`${PROOF_STEP} must declare its environment`);
  }
  return Object.fromEntries(
    Object.entries(env).filter(([, value]) => !value.includes('${{')),
  );
};

const run = (overrides: Record<string, Json> = {}): Record<string, Json> => ({
  conclusion: 'success',
  event: 'pull_request',
  headRepository: { fullName: REPOSITORY },
  headSha: HEAD,
  id: RUN_ID,
  path: '.github/workflows/standards.yml',
  repository: { fullName: REPOSITORY },
  ...overrides,
});

const jobs = (
  qualityConclusion = 'success',
  checkConclusion = 'success',
  checkRunId = CHECK_RUN_ID,
) => ({
  jobs: [
    {
      checkRunUrl: `https://api.github.com/repos/${REPOSITORY}/check-runs/${checkRunId}`,
      conclusion: qualityConclusion,
      name: 'quality',
    },
    { checkRunUrl: 'unused', conclusion: checkConclusion, name: 'check' },
  ],
});

const treeAnnotation = (overrides: Record<string, Json> = {}) => [
  {
    annotationLevel: 'notice',
    message: TREE,
    title: TREE_TITLE,
    ...overrides,
  },
];

const endpoints = {
  annotations: (id: number) =>
    `repos/${REPOSITORY}/check-runs/${id}/annotations?per_page=100`,
  commit: `repos/${REPOSITORY}/git/commits/${SHA}`,
  jobs: (id: number) =>
    `repos/${REPOSITORY}/actions/runs/${id}/jobs?filter=latest&per_page=100`,
  pulls: `repos/${REPOSITORY}/commits/${SHA}/pulls`,
  runs: `repos/${REPOSITORY}/actions/workflows/standards.yml/runs?head_sha=${HEAD}&event=pull_request&status=success&per_page=100`,
};

const provenApi = (): Record<string, Json> => ({
  [endpoints.commit]: { tree: { sha: TREE } },
  [endpoints.pulls]: [
    {
      base: { repo: { fullName: REPOSITORY } },
      head: { repo: { fullName: REPOSITORY }, sha: HEAD },
      mergeCommitSha: SHA,
      mergedAt: MERGED_AT,
    },
  ],
  [endpoints.runs]: { workflowRuns: [run()] },
  [endpoints.jobs(RUN_ID)]: jobs(),
  [endpoints.annotations(CHECK_RUN_ID)]: treeAnnotation(),
});

const prove = (api: Record<string, Json>, runAttempt = '1') => {
  const { output, status } = runStepWithApi(PROOF_STEP, api, {
    ...process.env,
    ...proofEnvironment(),
    ...Object.fromEntries([
      ['GITHUB_RUN_ATTEMPT', runAttempt],
      ['REPOSITORY', REPOSITORY],
      ['SHA', SHA],
    ]),
  });
  return { proven: output === 'proven=true\n', status };
};

const without = (
  api: Record<string, Json>,
  endpoint: string,
): Record<string, Json> =>
  Object.fromEntries(Object.entries(api).filter(([key]) => key !== endpoint));

const FULL_GATE_CASES: ReadonlyArray<readonly [string, Record<string, Json>]> =
  [
    ['no merged pull request', { [endpoints.pulls]: [] }],
    [
      'a pull request from a fork',
      {
        [endpoints.pulls]: [
          {
            base: { repo: { fullName: REPOSITORY } },
            head: { repo: { fullName: FORK }, sha: HEAD },
            mergeCommitSha: SHA,
            mergedAt: MERGED_AT,
          },
        ],
      },
    ],
    ['no successful run', { [endpoints.runs]: { workflowRuns: [] } }],
    [
      'a fork run',
      {
        [endpoints.runs]: {
          workflowRuns: [run({ headRepository: { fullName: FORK } })],
        },
      },
    ],
    [
      'another workflow',
      {
        [endpoints.runs]: {
          workflowRuns: [run({ path: '.github/workflows/other.yml' })],
        },
      },
    ],
    [
      'a push run',
      { [endpoints.runs]: { workflowRuns: [run({ event: 'push' })] } },
    ],
    [
      'a failed run',
      {
        [endpoints.runs]: { workflowRuns: [run({ conclusion: 'failure' })] },
      },
    ],
    [
      'a skipped draft quality job',
      { [endpoints.jobs(RUN_ID)]: jobs('skipped') },
    ],
    [
      'a failed check job',
      { [endpoints.jobs(RUN_ID)]: jobs('success', 'failure') },
    ],
    [
      'a different validated tree',
      {
        [endpoints.annotations(CHECK_RUN_ID)]: treeAnnotation({
          message: 'e'.repeat(SHA_LENGTH),
        }),
      },
    ],
    [
      'a tree record under another title',
      {
        [endpoints.annotations(CHECK_RUN_ID)]: treeAnnotation({
          title: 'Something else',
        }),
      },
    ],
    [
      'a tree record as a warning',
      {
        [endpoints.annotations(CHECK_RUN_ID)]: treeAnnotation({
          annotationLevel: 'warning',
        }),
      },
    ],
  ];

afterEach(cleanupTmpDirs);

describe('main-push reuse proof', () => {
  it('proves a same-repository pull request run that validated the pushed tree', () => {
    expect(prove(provenApi())).toEqual({ proven: true, status: 0 });
  });

  it.each(FULL_GATE_CASES)('runs the full gate for %s', (_label, overrides) => {
    expect(prove({ ...provenApi(), ...overrides })).toEqual({
      proven: false,
      status: 0,
    });
  });
});

describe('main-push reuse proof edge cases', () => {
  // A re-run can follow an attempt whose full gate failed on this tree.
  it('runs the full gate on a re-run', () => {
    expect(prove(provenApi(), '2')).toEqual({
      proven: false,
      status: 0,
    });
  });

  it('keeps looking past a run that recorded another tree', () => {
    expect(
      prove({
        ...provenApi(),
        [endpoints.runs]: {
          workflowRuns: [run({ id: OTHER_RUN_ID }), run()],
        },
        [endpoints.jobs(OTHER_RUN_ID)]: jobs(
          'success',
          'success',
          OTHER_CHECK_RUN_ID,
        ),
        [endpoints.annotations(OTHER_CHECK_RUN_ID)]: [],
      }),
    ).toEqual({ proven: true, status: 0 });
  });
});

describe('main-push reuse proof errors', () => {
  it.each(['commit', 'pulls', 'runs'] as const)(
    'fails without proving when the %s lookup fails',
    (endpoint) => {
      const result = prove(without(provenApi(), endpoints[endpoint]));
      expect(result.proven).toBe(false);
      expect(result.status).not.toBe(0);
    },
  );
});

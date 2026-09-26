import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { parse } from 'yaml';
import {
  ACTUAL_UPSTREAM,
  cleanupTmpDirs,
  mkTmp,
  runProcess,
  write,
  yamlRunScript,
} from './cli-test-support';

const WORKFLOW = join(ACTUAL_UPSTREAM, '.github/workflows/standards.yml');
const PROOF_STEP = 'Prove a validated pull request result';
const EXECUTABLE_MODE = 0o755;
const SHA_LENGTH = 40;
const SECONDS_PER_HOUR = 3600;
const MILLISECONDS_PER_SECOND = 1000;
const STALE_TURBO_HOURS = 48;
const RUN_ID = 12;
const OTHER_RUN_ID = 13;
const CHECK_RUN_ID = 34;
const OTHER_CHECK_RUN_ID = 35;
const REPOSITORY = 'owner/repo';
const FORK = 'contributor/repo';
const SHA = 'a'.repeat(SHA_LENGTH);
const HEAD = 'b'.repeat(SHA_LENGTH);
const TREE = 'c'.repeat(SHA_LENGTH);
const LOCK_HASH = 'd'.repeat(SHA_LENGTH);
const REF = 'refs/heads/main';
const TREE_TITLE = 'Standards validated tree';
const SNAKE_BOUNDARY = /[A-Z]/gu;
const ENDPOINT_SEPARATOR = /[^A-Za-z0-9]/gu;

type Json =
  | boolean
  | number
  | string
  | null
  | Array<Json>
  | { [key: string]: Json };

// Fixtures are written in camelCase and served in GitHub's snake_case.
const snakeCase = (value: Json): Json => {
  if (Array.isArray(value)) {
    return value.map(snakeCase);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key.replace(SNAKE_BOUNDARY, (letter) => `_${letter.toLowerCase()}`),
        snakeCase(entry),
      ]),
    );
  }
  return value;
};

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

const hoursAgo = (hours: number): string =>
  new Date(
    Date.now() - hours * SECONDS_PER_HOUR * MILLISECONDS_PER_SECOND,
  ).toISOString();

const cacheList = (keys: ReadonlyArray<string>, createdAt = hoursAgo(1)) => ({
  actionsCaches: keys.map((key) => ({ createdAt, key })),
});

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
  caches: (prefix: string) =>
    `repos/${REPOSITORY}/actions/caches?ref=${REF}&key=${prefix}&per_page=100`,
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
      mergedAt: hoursAgo(0),
    },
  ],
  [endpoints.runs]: { workflowRuns: [run()] },
  [endpoints.jobs(RUN_ID)]: jobs(),
  [endpoints.annotations(CHECK_RUN_ID)]: treeAnnotation(),
  [endpoints.caches('bun-packages-v2-')]: cacheList([
    'bun-packages-v2-Linux-X64-old',
    `bun-packages-v2-Linux-X64-${LOCK_HASH}`,
  ]),
  [endpoints.caches('playwright-v2-')]: cacheList([]),
  [endpoints.caches('turbo-trusted-v2-')]: cacheList([
    `turbo-trusted-v2-Linux-X64-${SHA}`,
  ]),
});

const GH_STUB = `#!/usr/bin/env bash
set -euo pipefail
[ "$1" = api ] || exit 2
shift
endpoint=
for argument in "$@"; do
  case "$argument" in
    --paginate) ;;
    -*) echo "unexpected gh flag $argument" >&2; exit 2 ;;
    *) endpoint=$argument ;;
  esac
done
file="$FIXTURE/api/$(printf '%s' "$endpoint" | tr -c 'A-Za-z0-9' '_').json"
[ -f "$file" ] || { echo "HTTP 404: $endpoint" >&2; exit 1; }
cat "$file"
`;

const prove = (api: Record<string, Json>, lockHash = LOCK_HASH) => {
  const fixture = mkTmp('standards-reuse-proof-');
  for (const [endpoint, body] of Object.entries(api)) {
    write(
      fixture,
      `api/${endpoint.replace(ENDPOINT_SEPARATOR, '_')}.json`,
      JSON.stringify(snakeCase(body)),
    );
  }
  write(fixture, 'bin/gh', GH_STUB);
  chmodSync(join(fixture, 'bin/gh'), EXECUTABLE_MODE);
  const outputPath = join(fixture, 'output');
  const result = runProcess(
    'bash',
    fixture,
    ['-euo', 'pipefail', '-c', yamlRunScript(WORKFLOW, PROOF_STEP)],
    {
      ...process.env,
      ...proofEnvironment(),
      ...Object.fromEntries([
        ['FIXTURE', fixture],
        ['GITHUB_OUTPUT', outputPath],
        ['LOCK_HASH', lockHash],
        ['PATH', `${join(fixture, 'bin')}:${process.env.PATH ?? ''}`],
        ['REF', REF],
        ['REPOSITORY', REPOSITORY],
        ['SHA', SHA],
      ]),
    },
  );
  return {
    proven: existsSync(outputPath)
      ? readFileSync(outputPath, 'utf8') === 'proven=true\n'
      : false,
    status: result.status,
  };
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
            mergedAt: hoursAgo(0),
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
    [
      'no Bun snapshot for the current lock',
      {
        [endpoints.caches('bun-packages-v2-')]: cacheList([
          'bun-packages-v2-Linux-X64-old',
        ]),
      },
    ],
    [
      'Playwright snapshots only for another lock',
      {
        [endpoints.caches('playwright-v2-')]: cacheList([
          'playwright-v2-Linux-X64-old',
        ]),
      },
    ],
    [
      'no Turbo snapshot',
      { [endpoints.caches('turbo-trusted-v2-')]: cacheList([]) },
    ],
    [
      'a stale Turbo snapshot',
      {
        [endpoints.caches('turbo-trusted-v2-')]: cacheList(
          [`turbo-trusted-v2-Linux-X64-${SHA}`],
          hoursAgo(STALE_TURBO_HOURS),
        ),
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
  it('runs the full gate without a lockfile hash', () => {
    expect(prove(provenApi(), '')).toEqual({ proven: false, status: 0 });
  });

  it('accepts Playwright snapshots for the current lock', () => {
    expect(
      prove({
        ...provenApi(),
        [endpoints.caches('playwright-v2-')]: cacheList([
          `playwright-v2-Linux-X64-${LOCK_HASH}`,
        ]),
      }),
    ).toEqual({ proven: true, status: 0 });
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

  it('fails without proving when a cache lookup fails', () => {
    const result = prove(
      without(provenApi(), endpoints.caches('turbo-trusted-v2-')),
    );
    expect(result.proven).toBe(false);
    expect(result.status).not.toBe(0);
  });
});

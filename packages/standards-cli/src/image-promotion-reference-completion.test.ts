import { expect, it } from 'bun:test';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { ACTUAL_UPSTREAM, runProcess } from './cli-test-support';
import {
  contract,
  DIGEST_A,
  environment,
  SHA_A,
  SHA_LENGTH,
} from './image-promotion-reference-contract-test-support';

const MERGE_SHA = 'd'.repeat(SHA_LENGTH);
const HEAD_SHA = 'f'.repeat(SHA_LENGTH);
const PREFIX_LENGTH = 12;
const DIGEST_PREFIX_START = 'sha256:'.length;
const marker = `promotion-source: example/app@${SHA_A} digest=${DIGEST_A}`;
const branch = `image-bump/web/${SHA_A.slice(0, PREFIX_LENGTH)}-${DIGEST_A.slice(DIGEST_PREFIX_START, DIGEST_PREFIX_START + PREFIX_LENGTH)}`;
type Fixture = {
  readonly checks: string;
  readonly checksExit: number;
  readonly content: string;
  readonly prs: string;
  readonly result: string;
  readonly runs: string;
  readonly view: string;
  readonly watch: string;
};

const images = {
  web: {
    digest: DIGEST_A,
    promotedSourceSha: SHA_A,
    promotionEnabled: true,
  },
};
const trustedView = {
  author: { login: 'promotion-bot[bot]' },
  files: [{ path: 'infra/images.json' }],
  headRefName: branch,
  headRefOid: HEAD_SHA,
  headRepository: { nameWithOwner: 'example/infra' },
  mergeCommit: { oid: MERGE_SHA },
  state: 'MERGED',
};
const checksPage = (checks: ReadonlyArray<unknown>) =>
  Object.fromEntries([['check_runs', checks]]);
const trustedCheck = {
  name: 'trusted-promotion-provenance',
  ...Object.fromEntries([['head_sha', HEAD_SHA]]),
  status: 'completed',
  conclusion: 'success',
  app: { slug: 'github-actions' },
};
const success: Fixture = {
  checks: JSON.stringify([checksPage([trustedCheck])]),
  checksExit: 0,
  content: JSON.stringify({
    content: Buffer.from(JSON.stringify(images)).toString('base64'),
  }),
  prs: JSON.stringify([{ body: marker, number: 7, state: 'MERGED' }]),
  result: JSON.stringify({
    conclusion: 'success',
    headSha: MERGE_SHA,
    jobs: [{ conclusion: 'success', name: 'deploy' }],
  }),
  runs: JSON.stringify([{ databaseId: 9, headSha: MERGE_SHA }]),
  view: JSON.stringify(trustedView),
  watch: 'success',
};

const ghFixture = `
gh() {
  case "$1 $2" in
    "pr list") printf '%s' "$PRS_JSON" ;;
    "pr view")
      if [[ "$*" == *statusCheckRollup* ]]; then
        echo "Resource not accessible by integration: statuses permission missing" >&2
        return 1
      fi
      printf '%s' "$VIEW_JSON" ;;
    "api repos/example/infra/commits/$HEAD_SHA/check-runs?check_name=trusted-promotion-provenance&filter=latest&per_page=100")
      test "$3 $4" = "--paginate --slurp" || return 2
      printf '%s' "$CHECKS_JSON"
      return "$CHECKS_EXIT" ;;
    "api repos/example/infra/contents/infra/images.json?ref=$MERGE_SHA") printf '%s' "$CONTENT_JSON" ;;
    "run list") printf '%s' "$RUNS_JSON" ;;
    "run watch") test "$WATCH_RESULT" = success ;;
    "run view") printf '%s' "$RESULT_JSON" ;;
    *) return 2 ;;
  esac
}
`;

const runFixture = (fixture: Fixture) =>
  runProcess(
    'bash',
    ACTUAL_UPSTREAM,
    [
      '-c',
      `set -euo pipefail\n${ghFixture}\n${contract('completion-trace', 'sh')}`,
    ],
    environment([
      ['APP', 'web'],
      ['CHECKS_JSON', fixture.checks],
      ['CHECKS_EXIT', String(fixture.checksExit)],
      ['HEAD_SHA', HEAD_SHA],
      ['CONTENT_JSON', fixture.content],
      ['DIGEST', DIGEST_A],
      ['MERGE_SHA', MERGE_SHA],
      ['PATH', process.env.PATH],
      ['PRS_JSON', fixture.prs],
      ['RESULT_JSON', fixture.result],
      ['RUNS_JSON', fixture.runs],
      ['SOURCE_REPOSITORY', 'example/app'],
      ['SOURCE_SHA', SHA_A],
      ['VIEW_JSON', fixture.view],
      ['WATCH_RESULT', fixture.watch],
    ]),
  );

it('ignores open and closed copies before merged uniqueness', () => {
  for (const state of ['OPEN', 'CLOSED']) {
    const prs = JSON.stringify([
      { body: marker, number: 6, state },
      { body: marker, number: 7, state: 'MERGED' },
    ]);
    expect(runFixture({ ...success, prs }).status, state).toBe(0);
  }
});

it('rejects missing, multiple, and forged merged candidates', () => {
  const forgedViews = [
    { ...trustedView, author: { login: 'attacker' } },
    {
      ...trustedView,
      headRepository: { nameWithOwner: 'attacker/infra' },
    },
    { ...trustedView, headRefName: 'image-bump/web/forged' },
    {
      ...trustedView,
      files: [{ path: 'infra/images.json' }, { path: 'backdoor.sh' }],
    },
    { ...trustedView, headRefOid: 'not-a-sha' },
  ];
  const invalid: ReadonlyArray<Fixture> = [
    { ...success, prs: '[]' },
    {
      ...success,
      prs: JSON.stringify([
        { body: marker, number: 7, state: 'MERGED' },
        { body: marker, number: 8, state: 'MERGED' },
      ]),
    },
    ...forgedViews.map((view) => ({ ...success, view: JSON.stringify(view) })),
  ];
  for (const fixture of invalid) {
    expect(runFixture(fixture).status).not.toBe(0);
  }
});

it('requires the exact resulting pin and successful exact deploy', () => {
  const wrongImages = {
    ...images,
    web: { ...images.web, promotedSourceSha: 'e'.repeat(SHA_LENGTH) },
  };
  const failures: ReadonlyArray<Fixture> = [
    {
      ...success,
      content: JSON.stringify({
        content: Buffer.from(JSON.stringify(wrongImages)).toString('base64'),
      }),
    },
    { ...success, runs: '[]' },
    {
      ...success,
      result: JSON.stringify({
        conclusion: 'failure',
        headSha: MERGE_SHA,
        jobs: [{ conclusion: 'failure', name: 'deploy' }],
      }),
      watch: 'failure',
    },
  ];
  expect(runFixture(success).status).toBe(0);
  for (const fixture of failures) {
    expect(runFixture(fixture).status).not.toBe(0);
  }
});

it('uses only supported gh arguments', () => {
  for (const line of contract('completion-trace', 'sh')
    .split('\n')
    .filter((value) => value.includes('gh '))) {
    expect(line).not.toContain('--arg');
  }
});

it('reads a successful provenance check without commit-status permission and across pages', () => {
  const checks = JSON.stringify([checksPage([]), checksPage([trustedCheck])]);
  expect(runFixture({ ...success, checks }).status).toBe(0);
});

it('fails closed on untrusted checks, duplicate checks, malformed responses and API failures', () => {
  const invalidChecks = [
    [],
    [trustedCheck, trustedCheck],
    [trustedCheck, { ...trustedCheck, conclusion: 'failure' }],
    [{ ...trustedCheck, conclusion: 'failure' }],
    [{ ...trustedCheck, conclusion: 'neutral' }],
    [{ ...trustedCheck, conclusion: 'skipped' }],
    [{ ...trustedCheck, status: 'in_progress', conclusion: null }],
    [{ ...trustedCheck, ...Object.fromEntries([['head_sha', MERGE_SHA]]) }],
    [{ ...trustedCheck, name: 'another-check' }],
    [{ ...trustedCheck, app: { slug: 'another-app' } }],
  ];
  for (const checkRuns of invalidChecks) {
    expect(
      runFixture({
        ...success,
        checks: JSON.stringify([checksPage(checkRuns)]),
      }).status,
    ).not.toBe(0);
  }
  for (const checks of ['not-json', '{}', '[{}]', '[{"check_runs":null}]']) {
    expect(runFixture({ ...success, checks }).status).not.toBe(0);
  }
  expect(runFixture({ ...success, checksExit: 1 }).status).not.toBe(0);
});

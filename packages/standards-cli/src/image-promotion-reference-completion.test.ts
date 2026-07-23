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
const PREFIX_LENGTH = 12;
const DIGEST_PREFIX_START = 'sha256:'.length;
const marker = `promotion-source: example/app@${SHA_A} digest=${DIGEST_A}`;
const branch = `image-bump/web/${SHA_A.slice(0, PREFIX_LENGTH)}-${DIGEST_A.slice(DIGEST_PREFIX_START, DIGEST_PREFIX_START + PREFIX_LENGTH)}`;
type Fixture = {
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
  headRepository: { nameWithOwner: 'example/infra' },
  mergeCommit: { oid: MERGE_SHA },
  state: 'MERGED',
  statusCheckRollup: [
    { conclusion: 'SUCCESS', name: 'trusted-promotion-provenance' },
  ],
};
const success: Fixture = {
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
    "pr view") printf '%s' "$VIEW_JSON" ;;
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
    { ...trustedView, statusCheckRollup: [] },
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

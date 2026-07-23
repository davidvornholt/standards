import { expect, it } from 'bun:test';
import process from 'node:process';
import { ACTUAL_UPSTREAM, runProcess } from './cli-test-support';
import {
  contract,
  DIGEST_A,
  environment,
  SHA_A,
  SHA_LENGTH,
} from './image-promotion-reference-contract-test-support';

const JQ_ARGUMENT_COMMAND_COUNT = 3;
const MERGE_SHA = 'd'.repeat(SHA_LENGTH);
const WRONG_SHA = 'e'.repeat(SHA_LENGTH);
const marker = `promotion-source: example/app@${SHA_A} digest=${DIGEST_A}`;
type Fixture = {
  readonly merge: string;
  readonly prs: string;
  readonly result: string;
  readonly runs: string;
  readonly watch: string;
};

const success: Fixture = {
  merge: JSON.stringify({
    mergeCommit: { oid: MERGE_SHA },
    state: 'MERGED',
  }),
  prs: JSON.stringify([{ body: marker, number: 7, state: 'MERGED' }]),
  result: JSON.stringify({
    conclusion: 'success',
    headSha: MERGE_SHA,
    jobs: [{ conclusion: 'success', name: 'deploy' }],
  }),
  runs: JSON.stringify([{ databaseId: 9, headSha: MERGE_SHA }]),
  watch: 'success',
};

const ghFixture = `
gh() {
  case "$1 $2" in
    "pr list") printf '%s' "$PRS_JSON" ;;
    "pr view") printf '%s' "$MERGE_JSON" ;;
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
      ['DIGEST', DIGEST_A],
      ['MERGE_JSON', fixture.merge],
      ['PATH', process.env.PATH],
      ['PRS_JSON', fixture.prs],
      ['RESULT_JSON', fixture.result],
      ['RUNS_JSON', fixture.runs],
      ['SOURCE_REPOSITORY', 'example/app'],
      ['SOURCE_SHA', SHA_A],
      ['WATCH_RESULT', fixture.watch],
    ]),
  );

it('uses supported gh syntax and standalone fail-closed jq', () => {
  const trace = contract('completion-trace', 'sh');
  for (const line of trace
    .split('\n')
    .filter((value) => value.includes('gh '))) {
    expect(line).not.toContain('--arg');
    expect(line).not.toContain('--jq');
  }
  expect(trace.match(/jq -er --arg/gu)?.length).toBe(JQ_ARGUMENT_COMMAND_COUNT);
  expect(runFixture(success).status).toBe(0);
});

it('fails for missing, open, ambiguous, and wrong-SHA fixtures', () => {
  const fixtures: ReadonlyArray<Fixture> = [
    { ...success, prs: '[]' },
    {
      ...success,
      prs: JSON.stringify([{ body: marker, number: 7, state: 'OPEN' }]),
    },
    {
      ...success,
      prs: JSON.stringify([
        { body: marker, number: 7, state: 'MERGED' },
        { body: marker, number: 8, state: 'MERGED' },
      ]),
    },
    {
      ...success,
      runs: JSON.stringify([{ databaseId: 9, headSha: WRONG_SHA }]),
    },
  ];
  for (const fixture of fixtures) {
    expect(runFixture(fixture).status).not.toBe(0);
  }
});

it('fails for ambiguous, skipped, and failing deploy jobs', () => {
  const fixtures: ReadonlyArray<Fixture> = [
    {
      ...success,
      result: JSON.stringify({
        conclusion: 'success',
        headSha: MERGE_SHA,
        jobs: [
          { conclusion: 'success', name: 'deploy' },
          { conclusion: 'success', name: 'deploy' },
        ],
      }),
    },
    {
      ...success,
      result: JSON.stringify({
        conclusion: 'success',
        headSha: MERGE_SHA,
        jobs: [{ conclusion: 'skipped', name: 'deploy' }],
      }),
    },
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
  for (const fixture of fixtures) {
    expect(runFixture(fixture).status).not.toBe(0);
  }
});

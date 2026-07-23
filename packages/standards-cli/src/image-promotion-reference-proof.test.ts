import { afterAll, expect, it } from 'bun:test';
import process from 'node:process';
import {
  ACTUAL_UPSTREAM,
  cleanupTmpDirs,
  mkTmp,
  runProcess,
} from './cli-test-support';
import {
  contract,
  DIGEST_A,
  DIGEST_B,
  environment,
  SHA_A,
  yamlContract,
} from './image-promotion-reference-contract-test-support';

afterAll(cleanupTmpDirs);

type Workflow = {
  readonly jobs: Readonly<
    Record<
      string,
      {
        readonly steps: ReadonlyArray<{
          readonly name?: string;
          readonly run?: string;
        }>;
      }
    >
  >;
};

const record = JSON.stringify({
  repository: 'example/app',
  ref: 'refs/heads/main',
  sha: SHA_A,
  runId: '42',
  image: 'ghcr.io/example/app/web',
  digest: DIGEST_A,
});
const successfulRun = `{"conclusion":"success","event":"push","head_branch":"main","head_sha":"${SHA_A}","path":".github/workflows/build.yml","workflow_id":123456}`;
const successfulJobs =
  '[{"jobs":[]},{"jobs":[{"id":7,"name":"build","conclusion":"success"}]}]';
const realisticLog = [
  '2026-07-23T00:00:00.1000000Z ##[group]Run set -euo pipefail',
  '2026-07-23T00:00:00.1000001Z \u001b[36;1mmarker_left=IMAGE_PROMOTION\u001b[0m',
  '2026-07-23T00:00:00.1000002Z \u001b[36;1mmarker_right=_RECORD\u001b[0m',
  `2026-07-23T00:00:00.1000003Z \u001b[32;1mIMAGE_PROMOTION_RECORD ${record}\u001b[0m`,
  '2026-07-23T00:00:00.1000004Z ##[endgroup]',
].join('\n');

const proofPrelude = `
gh() {
  case "$2" in
    repos/example/app/actions/runs/42) printf '%s' "$RUN_JSON" ;;
    repos/example/app/actions/runs/42/jobs) printf '%s' "$JOBS_JSON" ;;
    repos/example/app/actions/jobs/7/logs) printf '%s\\n' "$LOG_TEXT" ;;
    *) return 2 ;;
  esac
}
`;

const runProof = ({
  jobs = successfulJobs,
  log = realisticLog,
  run = successfulRun,
}: {
  readonly jobs?: string;
  readonly log?: string;
  readonly run?: string;
}) => {
  const runnerTemp = mkTmp('image-promotion-proof-');
  return runProcess(
    'bash',
    ACTUAL_UPSTREAM,
    ['-c', `${proofPrelude}\n${contract('source-proof', 'sh')}`],
    environment([
      ['DIGEST', DIGEST_A],
      ['IMAGE_REPOSITORY', 'ghcr.io/example/app/web'],
      ['JOBS_JSON', jobs],
      ['LOG_TEXT', log],
      ['PATH', process.env.PATH],
      ['RUN_JSON', run],
      ['RUNNER_TEMP', runnerTemp],
      ['SOURCE_REF', 'refs/heads/main'],
      ['SOURCE_REPOSITORY', 'example/app'],
      ['SOURCE_RUN_ID', '42'],
      ['SOURCE_SHA', SHA_A],
      ['SOURCE_WORKFLOW_ID', '123456'],
      ['SOURCE_WORKFLOW_PATH', '.github/workflows/build.yml'],
    ]),
  );
};

it('keeps the full marker out of echoed source and parses a real runner log', () => {
  const source = yamlContract<Workflow>('source-workflow');
  const emit = source.jobs.build.steps.find(
    (step) => step.name === 'Emit immutable promotion record',
  );
  expect(emit?.run).not.toContain('IMAGE_PROMOTION_RECORD');
  expect(realisticLog).toContain('##[group]Run');
  expect(realisticLog).toContain('\u001b[36;1m');
  expect(runProof({}).status).toBe(0);
});

it('requires one exact record from the authorized immutable workflow', () => {
  const wrongWorkflow = `{"conclusion":"success","event":"push","head_branch":"main","head_sha":"${SHA_A}","path":".github/workflows/unrelated.yml","workflow_id":999999}`;
  const ambiguousJobs =
    '[{"jobs":[{"id":7,"name":"build","conclusion":"success"},{"id":8,"name":"build","conclusion":"success"}]}]';
  for (const fixture of [
    { log: realisticLog.replace(DIGEST_A, DIGEST_B) },
    { log: `${realisticLog}\n${realisticLog}` },
    { jobs: ambiguousJobs },
    { run: wrongWorkflow },
  ]) {
    expect(runProof(fixture).status).not.toBe(0);
  }
});

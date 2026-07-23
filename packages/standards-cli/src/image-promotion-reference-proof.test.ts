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
} from './image-promotion-reference-contract-test-support';

afterAll(cleanupTmpDirs);

const proofPrelude = `
gh() {
  case "$2" in
    repos/example/app/actions/runs/42)
      printf '%s' '{"event":"push","head_branch":"main","head_sha":"${SHA_A}","conclusion":"success"}' ;;
    repos/example/app/actions/runs/42/jobs) printf '%s' "$JOBS_JSON" ;;
    repos/example/app/actions/jobs/7/logs)
      printf '2026-07-23T00:00:00Z IMAGE_PROMOTION_RECORD %s\\n' "$LOG_RECORD" ;;
    *) return 2 ;;
  esac
}
`;
const successfulJobs =
  '[{"jobs":[]},{"jobs":[{"id":7,"name":"build","conclusion":"success"}]}]';

const runProof = (logRecord: string, jobsJson = successfulJobs) => {
  const runnerTemp = mkTmp('image-promotion-proof-');
  return runProcess(
    'bash',
    ACTUAL_UPSTREAM,
    ['-c', `${proofPrelude}\n${contract('source-proof', 'sh')}`],
    environment([
      ['DIGEST', DIGEST_A],
      ['IMAGE_REPOSITORY', 'ghcr.io/example/app/web'],
      ['JOBS_JSON', jobsJson],
      ['LOG_RECORD', logRecord],
      ['PATH', process.env.PATH],
      ['RUNNER_TEMP', runnerTemp],
      ['SOURCE_REF', 'refs/heads/main'],
      ['SOURCE_REPOSITORY', 'example/app'],
      ['SOURCE_RUN_ID', '42'],
      ['SOURCE_SHA', SHA_A],
    ]),
  );
};

it('binds the exact paginated run log to the announced digest', () => {
  const record = JSON.stringify({
    repository: 'example/app',
    ref: 'refs/heads/main',
    sha: SHA_A,
    runId: '42',
    image: 'ghcr.io/example/app/web',
    digest: DIGEST_A,
  });
  expect(runProof(record).status).toBe(0);
  expect(runProof(record.replace(DIGEST_A, DIGEST_B)).status).not.toBe(0);
  expect(
    runProof(`${record}\nIMAGE_PROMOTION_RECORD ${record}`).status,
  ).not.toBe(0);
  const ambiguousJobs =
    '[{"jobs":[{"id":7,"name":"build","conclusion":"success"},{"id":8,"name":"build","conclusion":"success"}]}]';
  expect(runProof(record, ambiguousJobs).status).not.toBe(0);
});

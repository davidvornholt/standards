import { afterEach, expect, it } from 'bun:test';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import {
  ACTUAL_UPSTREAM,
  cleanupTmpDirs,
  mkTmp,
  runProcess,
  write,
} from './cli-test-support';
import {
  publishWorkflowJobs,
  workflowStep,
} from './publish-workflow-test-support';

const MODE = 0o755;
const SHA_LENGTH = 40;
const SHA = 'a'.repeat(SHA_LENGTH);
const fields = {
  sha: 'head_sha',
  branch: 'head_branch',
  repository: 'head_repository',
  name: 'full_name',
  runs: 'workflow_runs',
};
const run = (overrides: Record<string, unknown> = {}) => ({
  id: 12,
  [fields.sha]: SHA,
  [fields.branch]: 'main',
  [fields.repository]: { [fields.name]: 'owner/repo' },
  event: 'push',
  path: '.github/workflows/standards.yml',
  status: 'completed',
  conclusion: 'success',
  ...overrides,
});
const stub = (root: string, name: string, script: string) => {
  write(
    root,
    `bin/${name}`,
    `#!/usr/bin/env bash\nset -euo pipefail\n${script}\n`,
  );
  chmodSync(join(root, `bin/${name}`), MODE);
};
afterEach(cleanupTmpDirs);

it.each([
  { candidates: [run()], succeeds: true },
  { candidates: [run({ conclusion: 'failure' })], succeeds: false },
  { candidates: [run({ [fields.sha]: 'newer-main' }), run()], succeeds: true },
])(
  'gates publication on the exact push run: %j',
  ({ candidates, succeeds }) => {
    const root = mkTmp('publish-gate-');
    write(root, 'runs.json', JSON.stringify({ [fields.runs]: candidates }));
    stub(root, 'gh', 'cat "$FIXTURE/runs.json"');
    const result = runProcess(
      'bash',
      ACTUAL_UPSTREAM,
      [
        '-euo',
        'pipefail',
        '-c',
        workflowStep(
          publishWorkflowJobs().gate,
          'Wait for the exact commit quality gate',
        ).run ?? 'exit 99',
      ],
      {
        ...process.env,
        ...Object.fromEntries([
          ['PATH', `${join(root, 'bin')}:${process.env.PATH ?? ''}`],
          ['FIXTURE', root],
          ['RELEASE_SHA', SHA],
          ['GH_REPO', 'owner/repo'],
        ]),
      },
    );
    expect(result.status).toBe(succeeds ? 0 : 1);
  },
);

it('waits past unrelated successful runs before accepting this commit', () => {
  const root = mkTmp('publish-gate-wait-');
  write(
    root,
    'wrong.json',
    JSON.stringify({
      [fields.runs]: [
        run({ [fields.sha]: 'other' }),
        run({ path: '.github/workflows/other.yml' }),
        run({ event: 'pull_request' }),
        run({ [fields.repository]: { [fields.name]: 'fork/repo' } }),
      ],
    }),
  );
  write(root, 'right.json', JSON.stringify({ [fields.runs]: [run()] }));
  stub(
    root,
    'gh',
    'if [ -f "$FIXTURE/waited" ]; then cat "$FIXTURE/right.json"; else cat "$FIXTURE/wrong.json"; fi',
  );
  stub(root, 'sleep', 'touch "$FIXTURE/waited"');
  const result = runProcess(
    'bash',
    ACTUAL_UPSTREAM,
    [
      '-euo',
      'pipefail',
      '-c',
      workflowStep(
        publishWorkflowJobs().gate,
        'Wait for the exact commit quality gate',
      ).run ?? 'exit 99',
    ],
    {
      ...process.env,
      ...Object.fromEntries([
        ['PATH', `${join(root, 'bin')}:${process.env.PATH ?? ''}`],
        ['FIXTURE', root],
        ['RELEASE_SHA', SHA],
        ['GH_REPO', 'owner/repo'],
      ]),
    },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`Standards passed for ${SHA}`);
});

it.each(['missing', 'true', 'false'])(
  'checks inherited GitHub Release state %s without npm lookups',
  (releaseState) => {
    const root = mkTmp('publish-inherited-');
    stub(root, 'git', `echo ${SHA}`);
    stub(
      root,
      'gh',
      releaseState === 'missing' ? 'exit 1' : `echo ${releaseState}`,
    );
    stub(root, 'npm', 'exit 99');
    stub(root, 'curl', 'exit 99');
    const result = runProcess(
      'bash',
      ACTUAL_UPSTREAM,
      [
        '-euo',
        'pipefail',
        '-c',
        workflowStep(
          publishWorkflowJobs().publish,
          'Verify the inherited release completed',
        ).run ?? 'exit 99',
      ],
      {
        ...process.env,
        ...Object.fromEntries([
          ['PATH', `${join(root, 'bin')}:${process.env.PATH ?? ''}`],
          ['VERSION', '0.26.4'],
          ['PACKAGE_PATH', 'packages/standards-cli/package.json'],
        ]),
      },
    );
    expect(result.status).toBe(releaseState === 'false' ? 0 : 1);
  },
);

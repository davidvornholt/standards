import { expect, it } from 'bun:test';
import process from 'node:process';
import { ACTUAL_UPSTREAM, runProcess } from './cli-test-support';
import {
  environment,
  SHA_A,
  SHA_B,
  yamlContract,
} from './image-promotion-reference-contract-test-support';

type Step = {
  readonly id?: string;
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Readonly<Record<string, string>>;
};
type Job = {
  readonly if?: string;
  readonly needs?: string;
  readonly outputs?: Readonly<Record<string, string>>;
  readonly steps: ReadonlyArray<Step>;
};
type DeployWorkflow = {
  readonly concurrency: {
    readonly 'cancel-in-progress': boolean;
    readonly group: string;
  };
  readonly jobs: Readonly<Record<string, Job>>;
};

const workflow = yamlContract<DeployWorkflow>('deploy-guard');
const { deploy } = workflow.jobs;
if (deploy === undefined) {
  throw new Error('missing deploy job');
}
const guardIndex = deploy.steps.findIndex(
  (step) => step.name === 'Verify exact current main',
);
const mutationIndex = deploy.steps.findIndex(
  (step) => step.name === 'Mutate and read back',
);
const guard = deploy.steps[guardIndex]?.run ?? 'exit 2';
const mutation = deploy.steps[mutationIndex]?.run ?? 'exit 2';
const prelude = `
git() {
  case "$1 $2" in
    "rev-parse HEAD") printf '%s\\n' "$CHECKOUT_SHA" ;;
    "ls-remote origin") printf '%s\\trefs/heads/main\\n' "$REMOTE_MAIN_SHA" ;;
    *) return 2 ;;
  esac
}
deploy-and-read-back() { printf 'MUTATION\\n'; }
`;

const runGuard = ({
  checkout = SHA_A,
  event = SHA_A,
  gated = SHA_A,
  remote = SHA_A,
}: {
  readonly checkout?: string;
  readonly event?: string;
  readonly gated?: string;
  readonly remote?: string;
}) =>
  runProcess(
    'bash',
    ACTUAL_UPSTREAM,
    ['-c', `${prelude}\n${guard}\n${mutation}`],
    environment([
      ['CHECKOUT_SHA', checkout],
      ['GATED_SHA', gated],
      ['GITHUB_SHA', event],
      ['PATH', process.env.PATH],
      ['REMOTE_MAIN_SHA', remote],
    ]),
  );

it('parses an exact-SHA gate dependency and production serialization', () => {
  expect(workflow.concurrency).toEqual({
    'cancel-in-progress': false,
    group: 'production',
  });
  expect(deploy.needs).toBe('gate');
  expect(deploy.if).toContain("needs.gate.result == 'success'");
  expect(deploy.if).toContain('needs.gate.outputs.gated-sha == github.sha');
  expect(workflow.jobs.gate?.outputs?.['gated-sha']).toContain(
    'steps.gated.outputs.sha',
  );
});

it('places all four equality checks immediately before first mutation', () => {
  expect(guardIndex).toBeGreaterThan(0);
  expect(mutationIndex).toBe(guardIndex + 1);
  expect(guard).toContain('git rev-parse HEAD');
  expect(guard).toContain('git ls-remote origin refs/heads/main');
  expect(guard).toContain('"$checkout_sha" = "$GATED_SHA"');
  expect(guard).toContain('"$GATED_SHA" = "$GITHUB_SHA"');
  expect(guard).toContain('"$GITHUB_SHA" = "$remote_main_sha"');
});

it('mutates current main and gives every stale queued permutation zero writes', () => {
  expect(runGuard({})).toMatchObject({ status: 0, stdout: 'MUTATION\n' });
  for (const fixture of [
    { checkout: SHA_B },
    { gated: SHA_B },
    { event: SHA_B },
    { remote: SHA_B },
  ]) {
    const result = runGuard(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('MUTATION');
  }
});

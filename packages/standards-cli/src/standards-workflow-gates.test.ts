import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { parse } from 'yaml';
import { ACTUAL_UPSTREAM, runProcess, yamlRunScript } from './cli-test-support';

const WORKFLOW = join(ACTUAL_UPSTREAM, '.github/workflows/standards.yml');
const AGGREGATE_STEP = 'Require all standards gates';
const PROOF_STEP = 'Prove a validated pull request result';
const GATE_RUN_CONDITION =
  "!cancelled() && !github.event.pull_request.draft && needs.reuse.outputs.proven != 'true'";
const CACHE_PREFIX_ENVIRONMENT = [
  'BUN_CACHE_PREFIX',
  'PLAYWRIGHT_CACHE_PREFIX',
  'TURBO_CACHE_PREFIX',
] as const;

type Step = {
  readonly env?: Record<string, string>;
  readonly if?: string;
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
};
type Job = {
  readonly 'continue-on-error'?: boolean;
  readonly if?: string;
  readonly name?: string;
  readonly needs?: string | ReadonlyArray<string>;
  readonly outputs?: Record<string, string>;
  readonly permissions?: Record<string, string>;
  readonly steps: ReadonlyArray<Step & { 'continue-on-error'?: boolean }>;
};
type Workflow = {
  readonly jobs: Record<string, Job>;
  readonly on: Record<string, { readonly types?: Array<string> }>;
};

const workflow = (): Workflow =>
  parse(readFileSync(WORKFLOW, 'utf8')) as Workflow;
const expression = (body: string): string => `${'$'}{{ ${body} }}`;

describe('draft pull requests', () => {
  it('run the gate when the pull request becomes ready for review', () => {
    expect(workflow().on.pull_request?.types).toEqual([
      'opened',
      'synchronize',
      'reopened',
      'ready_for_review',
    ]);
  });

  it('skip every gate', () => {
    const { jobs } = workflow();
    expect(jobs.quality?.if).toBe(GATE_RUN_CONDITION);
    expect(jobs['nix-discovery']?.if).toEndWith(GATE_RUN_CONDITION);
  });

  // GitHub reports a skipped job as a passing required check. A draft run must
  // therefore never report `check` itself, or it would satisfy the ruleset.
  it('report the aggregator under a name that cannot satisfy the required check', () => {
    const { check } = workflow().jobs;
    expect(check?.if).toBe('always() && !github.event.pull_request.draft');
    expect(check?.name).toBe(
      expression(
        "github.event.pull_request.draft && 'check (runs when ready for review)' || 'check'",
      ),
    );
  });
});

describe('main-push reuse wiring', () => {
  it('proves reuse in a push-only preflight that runs no repository code', () => {
    const { reuse } = workflow().jobs;
    expect(reuse?.if).toBe("github.event_name == 'push'");
    expect(reuse?.permissions).toEqual({
      actions: 'read',
      checks: 'read',
      contents: 'read',
      'pull-requests': 'read',
    });
    expect(reuse?.outputs).toEqual({
      proven: expression('steps.proof.outputs.proven'),
    });
    expect(reuse?.steps.map((step) => step.name)).toEqual([
      'Checkout the lockfile',
      PROOF_STEP,
    ]);
    expect(reuse?.steps[0]?.with).toEqual({
      'persist-credentials': false,
      'sparse-checkout': 'bun.lock',
      'sparse-checkout-cone-mode': false,
    });
    // A proof error must select the full gate, never fail the run.
    expect(reuse?.steps[1]?.['continue-on-error']).toBe(true);
  });

  it('gates every source-repository and consumer gate on the proof', () => {
    const { jobs } = workflow();
    expect(jobs.quality?.needs).toBe('reuse');
    expect(jobs['nix-discovery']?.needs).toBe('reuse');
    expect(jobs.check?.needs).toContain('reuse');
  });

  it('records the validated tree first, and only for pull request runs', () => {
    const [checkout, record] = workflow().jobs.quality?.steps ?? [];
    expect(checkout?.uses).toBe('actions/checkout@v7');
    expect(record).toEqual({
      if: "github.event_name == 'pull_request'",
      name: 'Record the validated tree',
      run: 'echo "::notice title=Standards validated tree::$(git rev-parse \'HEAD^{tree}\')"',
    });
  });

  it('checks freshness against the caches the quality job publishes', () => {
    const { jobs } = workflow();
    const proofEnvironment =
      jobs.reuse?.steps.find((step) => step.name === PROOF_STEP)?.env ?? {};
    const savedKeys = (jobs.quality?.steps ?? [])
      .filter((step) => step.uses?.startsWith('actions/cache/save@'))
      .map((step) => String(step.with?.key));

    expect(savedKeys).toHaveLength(CACHE_PREFIX_ENVIRONMENT.length);
    for (const variable of CACHE_PREFIX_ENVIRONMENT) {
      const prefix = proofEnvironment[variable] ?? '';
      expect(prefix).not.toBe('');
      expect(savedKeys.filter((key) => key.startsWith(prefix))).toHaveLength(1);
    }
  });
});

describe('check aggregator reuse', () => {
  const results = ['success', 'failure', 'cancelled', 'skipped'] as const;
  const aggregate = (env: Readonly<Record<string, string>>): number =>
    runProcess(
      'bash',
      ACTUAL_UPSTREAM,
      ['-euo', 'pipefail', '-c', yamlRunScript(WORKFLOW, AGGREGATE_STEP)],
      { ...process.env, ...env },
    ).status;

  // Every combination of the aggregator's reuse-relevant inputs.
  const reuseCases = Object.entries({
    eventName: ['push', 'pull_request'],
    isSourceRepository: ['true', 'false'],
    qualityResult: results,
    reuseProven: ['true', 'false', ''],
    reuseResult: results,
  }).reduce<ReadonlyArray<Readonly<Record<string, string>>>>(
    (cases, [axis, values]) =>
      cases.flatMap((partial) =>
        values.map((value) => ({ ...partial, [axis]: value })),
      ),
    [{}],
  );

  it('accepts a skipped gate only for a proven reuse on a main push', () => {
    for (const testCase of reuseCases) {
      const reused =
        testCase.qualityResult === 'skipped' &&
        testCase.eventName === 'push' &&
        testCase.reuseResult === 'success' &&
        testCase.reuseProven === 'true';
      const ranNixResult =
        testCase.isSourceRepository === 'true' ? 'success' : 'skipped';
      const nixResult = reused ? 'skipped' : ranNixResult;
      const status = aggregate(
        Object.fromEntries([
          ['EVENT_NAME', testCase.eventName],
          ['IS_SOURCE_REPOSITORY', testCase.isSourceRepository],
          ['NIX_DISCOVERY_RESULT', nixResult],
          ['NIX_RESULT', nixResult],
          ['QUALITY_RESULT', testCase.qualityResult],
          ['REUSE_PROVEN', testCase.reuseProven],
          ['REUSE_RESULT', testCase.reuseResult],
        ]),
      );

      expect(status).toBe(
        reused || testCase.qualityResult === 'success' ? 0 : 1,
      );
    }
  });

  it('rejects a source-repository reuse whose Nix gates still ran', () => {
    for (const nixResult of results.filter((result) => result !== 'skipped')) {
      expect(
        aggregate(
          Object.fromEntries([
            ['EVENT_NAME', 'push'],
            ['IS_SOURCE_REPOSITORY', 'true'],
            ['NIX_DISCOVERY_RESULT', nixResult],
            ['NIX_RESULT', nixResult],
            ['QUALITY_RESULT', 'skipped'],
            ['REUSE_PROVEN', 'true'],
            ['REUSE_RESULT', 'success'],
          ]),
        ),
      ).toBe(1);
    }
  });
});

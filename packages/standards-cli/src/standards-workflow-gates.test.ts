import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { parse } from 'yaml';
import { ACTUAL_UPSTREAM, runProcess, yamlRunScript } from './cli-test-support';

const WORKFLOW = join(ACTUAL_UPSTREAM, '.github/workflows/standards.yml');
const AGGREGATE_STEP = 'Require all standards gates';
const PROOF_STEP = 'Prove a validated pull request result';
const REQUEST_STEP = 'Request stale cache publication';
const GATE_RUN_CONDITION =
  "!cancelled() && !github.event.pull_request.draft && needs.reuse.outputs.proven != 'true'";
const STATUS_FUNCTION = /(?:^|\W)(?:!cancelled|always)\(\)/u;
const CACHE_PREFIX_ENVIRONMENT = [
  'BUN_CACHE_PREFIX',
  'PLAYWRIGHT_CACHE_PREFIX',
  'TURBO_CACHE_PREFIX',
] as const;
// Main publishes a Next.js compiler snapshot only when it compiled an app, so
// a dispatched run whose builds all hit the Turbo cache publishes none. A
// missing Next.js snapshot therefore cannot request publication: the request
// would repeat on every reused push without ever producing one.
const UNTRACKED_CACHE_PREFIXES = ['next-trusted-v1-'] as const;

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
  readonly concurrency: Record<string, string>;
  readonly jobs: Record<string, Job>;
  readonly on: Record<string, { readonly types?: Array<string> } | null>;
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
    const { jobs } = workflow();
    const check = jobs['required-check'];
    // Whatever name GitHub gives a skipped job, it is never the job id `check`.
    expect(Object.keys(jobs)).not.toContain('check');
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
    // Write access only creates the cache publication dispatch.
    expect(reuse?.permissions).toEqual({
      actions: 'write',
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
      REQUEST_STEP,
    ]);
    expect(reuse?.steps[0]?.with).toEqual({
      'persist-credentials': false,
      'sparse-checkout': 'bun.lock',
      'sparse-checkout-cone-mode': false,
    });
    // A proof error must select the full gate, never fail the run, and cache
    // state must never decide it.
    expect(reuse?.steps[1]?.['continue-on-error']).toBe(true);
    expect(JSON.stringify(reuse?.steps[1])).not.toContain('CACHE');
    // A failed publication request leaves caches stale, never the gate red.
    expect(reuse?.steps[2]?.if).toBe("steps.proof.outputs.proven == 'true'");
    expect(reuse?.steps[2]?.['continue-on-error']).toBe(true);
  });

  it('gates every source-repository and consumer gate on the proof', () => {
    const { jobs } = workflow();
    expect(jobs.quality?.needs).toBe('reuse');
    expect(jobs['nix-discovery']?.needs).toBe('reuse');
    expect(jobs['required-check']?.needs).toContain('reuse');
  });

  // `reuse` is skipped on every pull request, and GitHub's implicit `success()`
  // skips any job with a skipped ancestor. Every job downstream of `reuse`
  // must therefore state its own status condition.
  it('keeps every job downstream of the proof on an explicit status condition', () => {
    const { jobs } = workflow();
    const needsOf = (id: string): ReadonlyArray<string> => {
      const needs = jobs[id]?.needs ?? [];
      return typeof needs === 'string' ? [needs] : needs;
    };
    const dependsOnReuse = (id: string): boolean =>
      needsOf(id).some((need) => need === 'reuse' || dependsOnReuse(need));
    const downstream = Object.keys(jobs).filter(dependsOnReuse);

    expect(
      downstream.toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(['nix', 'nix-discovery', 'quality', 'required-check']);
    for (const id of downstream) {
      expect(jobs[id]?.if ?? '').toMatch(STATUS_FUNCTION);
    }
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
    const requestEnvironment =
      jobs.reuse?.steps.find((step) => step.name === REQUEST_STEP)?.env ?? {};
    const savedKeys = (jobs.quality?.steps ?? [])
      .filter((step) => step.uses?.startsWith('actions/cache/save@'))
      .map((step) => String(step.with?.key))
      .filter(
        (key) =>
          !UNTRACKED_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix)),
      );

    expect(savedKeys).toHaveLength(CACHE_PREFIX_ENVIRONMENT.length);
    for (const variable of CACHE_PREFIX_ENVIRONMENT) {
      const prefix = requestEnvironment[variable] ?? '';
      expect(prefix).not.toBe('');
      expect(savedKeys.filter((key) => key.startsWith(prefix))).toHaveLength(1);
    }
  });
});

describe('cache publication runs', () => {
  it('run as manual dispatches that release pollers never select', () => {
    const { on } = workflow();
    expect(Object.keys(on)).toEqual([
      'pull_request',
      'push',
      'workflow_dispatch',
    ]);
    expect(on.workflow_dispatch).toBeNull();
  });

  it('queue in one group that never cancels a running publication', () => {
    expect(workflow().concurrency).toEqual({
      group: `${expression('github.workflow')}-${expression(
        "github.event_name == 'pull_request' && format('{0}-{1}', github.ref, github.event.pull_request.draft && 'draft' || 'ready') || github.event_name == 'workflow_dispatch' && 'dispatch' || github.sha",
      )}`,
      'cancel-in-progress': expression("github.event_name == 'pull_request'"),
    });
  });

  it('run the full gate because only a push runs the reuse proof', () => {
    const { jobs } = workflow();
    expect(jobs.reuse?.if).toBe("github.event_name == 'push'");
    expect(jobs.quality?.if).toBe(GATE_RUN_CONDITION);
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

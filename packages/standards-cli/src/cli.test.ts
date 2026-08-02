// Black-box integration tests: drive the sync CLI as a subprocess against
// throwaway temp fixtures and assert its documented status/stdout/stderr.

import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseYaml } from 'yaml';
import {
  ACTUAL_UPSTREAM,
  cleanupTmpDirs,
  mkTmp,
  type RunResult,
  runProcess,
  SOPS_ACTION,
  write,
  yamlRunScript,
  yamlStep,
} from './cli-test-support';

const ENGINE = join(import.meta.dir, 'cli.ts');
const SYNC_WORKFLOW = join(
  ACTUAL_UPSTREAM,
  '.github/workflows/standards-sync.yml',
);
const STANDARDS_WORKFLOW = join(
  ACTUAL_UPSTREAM,
  '.github/workflows/standards.yml',
);
const NOTIFY_WORKFLOW = join(
  ACTUAL_UPSTREAM,
  '.github/workflows/notify-pause.yml',
);
const NIX_SYSTEM_METADATA = join(
  ACTUAL_UPSTREAM,
  'nix/bun-system-metadata.json',
);
const NIX_SYSTEM_MATRIX_FILTER = join(
  ACTUAL_UPSTREAM,
  'nix/bun-system-matrix.jq',
);
const SOPS_VERSION_ASSIGNMENT = /version=v\d+\.\d+\.\d+/gu;
const SOPS_CHECKSUM_ASSIGNMENT = /sha=[a-f0-9]{64}/gu;
// `sha=`/`version=` alone also match the Bun, CLI, and actionlint pins that
// legitimately live in the canonical workflow, so ownership is asked of the one
// string only a SOPS installer has.
const SOPS_RELEASE_URL = /github\.com\/getsops\/sops\/releases\/download\//gu;
const ACTIONLINT_ASSET_PATTERN =
  /actionlint_\$\{version\}_linux_\$\{arch\}\.tar\.gz/u;
const PINNED_STANDARDS_VERSION_PATTERN =
  /standards_version=(?<version>\d+\.\d+\.\d+)/u;
const MINIMUM_STANDARDS_VERSION_PATTERN =
  /MINIMUM_STANDARDS_VERSION: "(?<version>\d+\.\d+\.\d+)"/u;
const MAJOR_ACTION_REF = /^[^@\s]+@v\d+$/u;
const WRITE_PERMISSION_INPUT = /permission-\S+: write/u;
const SOURCE_REPOSITORY_CONDITION =
  "github.repository == 'davidvornholt/standards'";
const TURBO_CACHE_SAVE_CONDITION =
  "success() && github.ref == 'refs/heads/main' && steps.turbo-cache.outputs.cache-hit != 'true'";
const CACHE_FIXTURE_FILE_SIZE = 4096;
const OLDEST_CACHE_MTIME = 100;
const MIDDLE_CACHE_MTIME = 200;
const NEWEST_CACHE_MTIME = 300;
const STD_PATHS: ReadonlyArray<string> = [
  'sync-standards.json',
  '.github/dependabot.base.yml',
  'managed',
];

type Lock = { upstream: string; sha: string; files: Record<string, string> };
type WorkflowJob = Record<string, unknown>;
type WorkflowStep = Record<string, unknown>;
type ParsedWorkflow = {
  env?: Record<string, unknown>;
  jobs: Record<string, WorkflowJob>;
};

const INVALID_POLICY_CASES = [
  [
    'malformed JSON',
    'not json',
    'sync-standards.local.json must contain valid JSON',
  ],
  [
    'a non-object root',
    'null',
    'sync-standards.local.json must be a JSON object',
  ],
  [
    'a wrong autoSync type',
    '{ "autoSync": "false" }',
    '"autoSync" must be a boolean',
  ],
  [
    'a wrong ref type',
    '{ "ref": 1 }',
    '"ref" must be a non-empty single-line string',
  ],
  [
    'a newline in ref',
    '{ "ref": "main\\npresent=false" }',
    '"ref" must be a non-empty single-line string',
  ],
  [
    'a carriage return in ref',
    '{ "ref": "main\\rpresent=false" }',
    '"ref" must be a non-empty single-line string',
  ],
  [
    'an unsupported field',
    '{ "branch": "stable" }',
    'contains unsupported field(s): branch',
  ],
] as const;

const DEPENDABOT_OVERLAY = [
  'updates:',
  '  - package-ecosystem: nix',
  '    directory: /',
  '    schedule:',
  '      interval: weekly',
  '  - package-ecosystem: bun',
  '    directory: /',
  '    ignore:',
  '      - dependency-name: left-pad',
  '        versions: [">1.0.0"]',
  '',
].join('\n');

const read = (root: string, rel: string): string =>
  readFileSync(join(root, rel), 'utf8');
const readLock = (root: string): Lock =>
  JSON.parse(read(root, 'sync-standards.lock')) as Lock;
const snapshotTree = (
  root: string,
  current = root,
  snapshot: Record<string, string> = {},
): Record<string, string> => {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      snapshotTree(root, path, snapshot);
    } else {
      snapshot[relative(root, path)] = readFileSync(path).toString('base64');
    }
  }
  return snapshot;
};
const readProductionGithubFiles = (): ReadonlyArray<{
  readonly content: string;
  readonly path: string;
}> =>
  ['.github/workflows', '.github/actions'].flatMap((root) =>
    Object.entries(snapshotTree(join(ACTUAL_UPSTREAM, root))).map(
      ([path, content]) => ({
        content: Buffer.from(content, 'base64').toString('utf8'),
        path: `${root}/${path}`,
      }),
    ),
  );

const runExecutable = (
  executable: string,
  cwd: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> = {},
): RunResult => runProcess(executable, cwd, args, { ...process.env, ...env });
const run = (cwd: string, args: ReadonlyArray<string>): RunResult =>
  runExecutable('bun', cwd, [ENGINE, ...args]);

const workflowRunScript = (stepName: string): string =>
  yamlRunScript(SYNC_WORKFLOW, stepName);
const githubExpression = (expression: string): string =>
  `${'$'}{{ ${expression} }}`;
const githubMatrixExpression = (property: string): string =>
  githubExpression(`matrix.${property}`);
const TURBO_CACHE_KEY = `turbo-${githubExpression('runner.os')}-${githubExpression('runner.arch')}-${githubExpression('github.sha')}`;
const TURBO_CACHE_RESTORE_PREFIX = `turbo-${githubExpression('runner.os')}-${githubExpression('runner.arch')}-`;
const BUN_CACHE_KEY = `bun-packages-${githubExpression('runner.os')}-${githubExpression('runner.arch')}-${githubExpression("hashFiles('bun.lock')")}`;
const BUN_CACHE_RESTORE_PREFIX = `bun-packages-${githubExpression('runner.os')}-${githubExpression('runner.arch')}-`;
const BUN_CACHE_PATH = '~/.bun/install/cache';
const BUN_CACHE_SAVE_CONDITION =
  "success() && github.ref == 'refs/heads/main' && steps.bun-cache.outputs.cache-hit != 'true'";
const PLAYWRIGHT_CACHE_KEY = `playwright-${githubExpression('runner.os')}-${githubExpression('runner.arch')}-${githubExpression("hashFiles('bun.lock')")}`;
const PLAYWRIGHT_CACHE_RESTORE_PREFIX = `playwright-${githubExpression('runner.os')}-${githubExpression('runner.arch')}-`;
const PLAYWRIGHT_CACHE_PATH = '~/.cache/ms-playwright';
const PLAYWRIGHT_CACHE_SAVE_CONDITION =
  "success() && github.ref == 'refs/heads/main' && steps.a11y.outputs.present == 'true' && steps.playwright-cache.outputs.cache-hit != 'true'";
const runNixDiscovery = ({
  filter,
  metadata,
}: {
  readonly filter: string | undefined;
  readonly metadata: string | undefined;
}): { readonly output: string; readonly result: RunResult } => {
  const fixture = mkTmp('nix-discovery-');
  const outputPath = join(fixture, 'github-output');
  if (filter !== undefined) {
    write(fixture, 'nix/bun-system-matrix.jq', filter);
  }
  if (metadata !== undefined) {
    write(fixture, 'nix/bun-system-metadata.json', metadata);
  }
  const result = runExecutable(
    'bash',
    fixture,
    [
      '-euo',
      'pipefail',
      '-c',
      yamlRunScript(STANDARDS_WORKFLOW, 'Discover Nix matrix'),
    ],
    { GITHUB_OUTPUT: outputPath },
  );
  return {
    output: existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '',
    result,
  };
};

const yamlJobs = (path: string): Record<string, WorkflowJob> => {
  const parsedWorkflow: unknown = parseYaml(readFileSync(path, 'utf8'));
  if (
    typeof parsedWorkflow !== 'object' ||
    parsedWorkflow === null ||
    !('jobs' in parsedWorkflow) ||
    typeof parsedWorkflow.jobs !== 'object' ||
    parsedWorkflow.jobs === null
  ) {
    throw new Error(`${path} must contain a jobs mapping`);
  }
  const jobs: Record<string, WorkflowJob> = {};
  for (const [jobName, job] of Object.entries(parsedWorkflow.jobs)) {
    if (typeof job !== 'object' || job === null) {
      throw new Error(`${path} job ${jobName} must be a mapping`);
    }
    jobs[jobName] = job as WorkflowJob;
  }
  return jobs;
};

const workflowSteps = (
  job: WorkflowJob | undefined,
  jobName: string,
): ReadonlyArray<WorkflowStep> => {
  if (job === undefined || !Array.isArray(job.steps)) {
    throw new Error(`Workflow job ${jobName} must contain a steps array`);
  }
  return job.steps.map((step, index) => {
    if (typeof step !== 'object' || step === null) {
      throw new Error(
        `Workflow job ${jobName} step ${index} must be a mapping`,
      );
    }
    return step as WorkflowStep;
  });
};

const parseWorkflow = (path: string): ParsedWorkflow => {
  const workflow: unknown = parseYaml(readFileSync(path, 'utf8'));
  if (
    typeof workflow !== 'object' ||
    workflow === null ||
    !('jobs' in workflow) ||
    typeof workflow.jobs !== 'object' ||
    workflow.jobs === null
  ) {
    throw new Error(`${path} must contain a jobs mapping`);
  }
  return workflow as ParsedWorkflow;
};

const qualityStep = (workflow: ParsedWorkflow, name: string): WorkflowStep => {
  const step = workflowSteps(workflow.jobs.quality, 'quality').find(
    (candidate) => candidate.name === name,
  );
  if (step === undefined) {
    throw new Error(`Quality step not found: ${name}`);
  }
  return step;
};

const qualityEnvironment = (
  workflow: ParsedWorkflow,
): Record<string, unknown> => {
  const environment = workflow.jobs.quality.env;
  if (typeof environment !== 'object' || environment === null) {
    throw new Error('Quality job must contain an environment mapping');
  }
  return environment as Record<string, unknown>;
};

const assertQualityCacheConsumers = (
  workflow: ParsedWorkflow,
): ReadonlyArray<WorkflowStep> => {
  const environment = qualityEnvironment(workflow);
  if (
    'BUN_INSTALL_CACHE_DIR' in environment ||
    'PLAYWRIGHT_BROWSERS_PATH' in environment
  ) {
    throw new Error(
      'Executable cache paths must be initialized after the runner context exists',
    );
  }
  const expectedConsumerSteps = [
    {
      name: 'Install dependencies',
      run: 'bun install --frozen-lockfile',
    },
    {
      name: 'Install Playwright Chromium',
      if: "steps.a11y.outputs.present == 'true'",
      run: `set -euo pipefail
playwright=$(find . -path '*/node_modules/.bin/playwright' -print -quit)
if [ -z "$playwright" ]; then
  echo "::error::Found a browser a11y suite but no installed playwright binary. Declare @playwright/test in the workspace that owns the suite."
  exit 1
fi
"$playwright" install --with-deps chromium
`,
    },
    {
      name: 'Check',
      env: { STANDARDS_SKIP_GITHUB_CHECK: 'true' },
      run: 'bun run check',
    },
  ];
  const consumerSteps = expectedConsumerSteps.map(({ name }) =>
    qualityStep(workflow, name),
  );
  if (!isDeepStrictEqual(consumerSteps, expectedConsumerSteps)) {
    throw new Error(
      'Executable cache initialization and consumers do not match the approved contract',
    );
  }
  return consumerSteps;
};

const assertQualityCacheContract = (workflow: ParsedWorkflow): void => {
  const steps = workflowSteps(workflow.jobs.quality, 'quality');
  const cacheSteps = steps.filter(
    (step) =>
      typeof step.uses === 'string' && step.uses.startsWith('actions/cache'),
  );
  const expectedCacheSteps = [
    {
      name: 'Restore the Turbo cache',
      id: 'turbo-cache',
      uses: 'actions/cache/restore@v4',
      with: {
        path: '.turbo/cache',
        key: TURBO_CACHE_KEY,
        'restore-keys': `${TURBO_CACHE_RESTORE_PREFIX}\n`,
      },
    },
    {
      name: 'Restore the Bun package cache',
      id: 'bun-cache',
      uses: 'actions/cache/restore@v4',
      with: {
        path: BUN_CACHE_PATH,
        key: BUN_CACHE_KEY,
        'restore-keys': `${BUN_CACHE_RESTORE_PREFIX}\n`,
      },
    },
    {
      name: 'Restore the Playwright browser cache',
      if: "steps.a11y.outputs.present == 'true'",
      id: 'playwright-cache',
      uses: 'actions/cache/restore@v4',
      with: {
        path: PLAYWRIGHT_CACHE_PATH,
        key: PLAYWRIGHT_CACHE_KEY,
        'restore-keys': `${PLAYWRIGHT_CACHE_RESTORE_PREFIX}\n`,
      },
    },
    {
      name: 'Save the Bun package cache',
      if: BUN_CACHE_SAVE_CONDITION,
      uses: 'actions/cache/save@v4',
      with: { path: BUN_CACHE_PATH, key: BUN_CACHE_KEY },
    },
    {
      name: 'Save the Playwright browser cache',
      if: PLAYWRIGHT_CACHE_SAVE_CONDITION,
      uses: 'actions/cache/save@v4',
      with: { path: PLAYWRIGHT_CACHE_PATH, key: PLAYWRIGHT_CACHE_KEY },
    },
    {
      name: 'Save the Turbo cache',
      if: TURBO_CACHE_SAVE_CONDITION,
      uses: 'actions/cache/save@v4',
      with: { path: '.turbo/cache', key: TURBO_CACHE_KEY },
    },
  ];
  if (!isDeepStrictEqual(cacheSteps, expectedCacheSteps)) {
    throw new Error('Quality cache actions do not match the approved contract');
  }
  assertQualityCacheConsumers(workflow);

  const restoreIndex = steps.indexOf(cacheSteps[0] as WorkflowStep);
  const bunRestoreIndex = steps.indexOf(cacheSteps[1] as WorkflowStep);
  const installIndex = steps.indexOf(
    qualityStep(workflow, 'Install dependencies'),
  );
  const playwrightRestoreIndex = steps.indexOf(cacheSteps[2] as WorkflowStep);
  const playwrightInstallIndex = steps.indexOf(
    qualityStep(workflow, 'Install Playwright Chromium'),
  );
  const playwrightSaveIndex = steps.indexOf(cacheSteps[4] as WorkflowStep);
  const checkIndex = steps.indexOf(qualityStep(workflow, 'Check'));
  const bunSaveIndex = steps.indexOf(cacheSteps[3] as WorkflowStep);
  const pruneIndex = steps.indexOf(
    qualityStep(workflow, 'Prune the Turbo cache before save'),
  );
  const saveIndex = steps.indexOf(cacheSteps[5] as WorkflowStep);
  const orderedIndices = [
    restoreIndex,
    bunRestoreIndex,
    installIndex,
    playwrightRestoreIndex,
    playwrightInstallIndex,
    checkIndex,
    bunSaveIndex,
    playwrightSaveIndex,
    pruneIndex,
    saveIndex,
  ];
  for (const [index, stepIndex] of orderedIndices.entries()) {
    const previousIndex = orderedIndices[index - 1];
    if (
      stepIndex < 0 ||
      (previousIndex !== undefined && previousIndex >= stepIndex)
    ) {
      throw new Error(
        'Cache restore, consumers, prune, and save are out of order',
      );
    }
  }
  const pruneStep = qualityStep(workflow, 'Prune the Turbo cache before save');
  const pruneRun = pruneStep.run;
  if (
    !isDeepStrictEqual(Object.keys(pruneStep).sort(), ['if', 'name', 'run']) ||
    pruneStep.if !== TURBO_CACHE_SAVE_CONDITION ||
    typeof pruneRun !== 'string' ||
    !pruneRun.startsWith('set -euo pipefail\n')
  ) {
    throw new Error(
      'Turbo pruning must use strict shell failure handling on exactly the successful save condition',
    );
  }
};

const moveQualityStepBefore = (
  workflow: ParsedWorkflow,
  stepName: string,
  beforeStepName: string,
): void => {
  const qualityJob = workflow.jobs.quality;
  if (!Array.isArray(qualityJob.steps)) {
    throw new Error('Quality job must contain a steps array');
  }
  const stepIndex = qualityJob.steps.findIndex(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      candidate.name === stepName,
  );
  const beforeIndex = qualityJob.steps.findIndex(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      candidate.name === beforeStepName,
  );
  if (stepIndex < 0 || beforeIndex < 0) {
    throw new Error('Expected quality cache steps are missing');
  }
  const [movedStep] = qualityJob.steps.splice(stepIndex, 1);
  const adjustedBeforeIndex = qualityJob.steps.findIndex(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      candidate.name === beforeStepName,
  );
  qualityJob.steps.splice(adjustedBeforeIndex, 0, movedStep);
};

const rejectedQualityCacheMutations = (
  mutations: ReadonlyArray<(workflow: ParsedWorkflow) => void>,
): ReadonlyArray<boolean> =>
  mutations.map((mutate) => {
    const workflow = structuredClone(parseWorkflow(STANDARDS_WORKFLOW));
    mutate(workflow);
    try {
      assertQualityCacheContract(workflow);
      return false;
    } catch {
      return true;
    }
  });

// The block-scalar entries of a checkout step's `sparse-checkout` input, so a
// test can pin the whole list instead of spot-checking individual paths.
const sparseCheckoutPaths = (step: WorkflowStep): ReadonlyArray<string> => {
  const inputs = step.with;
  if (
    typeof inputs !== 'object' ||
    inputs === null ||
    !('sparse-checkout' in inputs) ||
    typeof inputs['sparse-checkout'] !== 'string'
  ) {
    throw new Error('Step has no block-scalar sparse-checkout input');
  }
  return inputs['sparse-checkout']
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
};

// The single answer to "is this a workflow file", shared by both workflow
// enumerators so a new accepted spelling can never reach only one of them. One
// caller passes a repo-relative path and the other a bare directory entry name,
// so this stays a suffix question and the name promises nothing about shape.
const hasWorkflowExtension = (candidate: string): boolean =>
  candidate.endsWith('.yml') || candidate.endsWith('.yaml');

const canonicalWorkflowPaths = (
  syncManifestPath: string,
): ReadonlyArray<string> => {
  const syncManifest: unknown = JSON.parse(
    readFileSync(syncManifestPath, 'utf8'),
  );
  if (
    typeof syncManifest !== 'object' ||
    syncManifest === null ||
    !('paths' in syncManifest) ||
    !Array.isArray(syncManifest.paths)
  ) {
    throw new Error('Sync manifest must contain a paths array');
  }
  return syncManifest.paths.filter(
    (path): path is string =>
      typeof path === 'string' &&
      path.startsWith('.github/workflows/') &&
      hasWorkflowExtension(path),
  );
};

// The single job allowed to select the configurable runner. Named once so the
// inspection that exempts it and the failure message that explains it cannot
// drift apart.
const CONFIGURABLE_RUNNER_WORKFLOW = '.github/workflows/standards.yml';
const CONFIGURABLE_RUNNER_JOB_NAME = 'quality';
const CONFIGURABLE_RUNNER_JOB = `${CONFIGURABLE_RUNNER_WORKFLOW}:${CONFIGURABLE_RUNNER_JOB_NAME}`;

const inspectCanonicalWorkflowRunnerBoundaries = (
  upstream: string,
): {
  readonly configurableRunnerOccurrences: number;
  readonly fixedRunnerJobDefinitions: ReadonlyArray<{
    readonly definition: string;
    readonly id: string;
  }>;
  readonly fixedRunnerJobs: Readonly<Record<string, unknown>>;
  readonly qualityRunner: unknown;
  readonly workflowPaths: ReadonlyArray<string>;
} => {
  const workflowPaths = canonicalWorkflowPaths(
    join(upstream, 'sync-standards.json'),
  );
  let configurableRunnerOccurrences = 0;
  let qualityRunner: unknown;
  const fixedRunnerJobs: Record<string, unknown> = {};
  const fixedRunnerJobDefinitions: Array<{
    readonly definition: string;
    readonly id: string;
  }> = [];
  for (const workflowPath of workflowPaths) {
    const absolutePath = join(upstream, workflowPath);
    const workflow = readFileSync(absolutePath, 'utf8');
    configurableRunnerOccurrences +=
      workflow.match(/vars\.CI_RUNNER/gu)?.length ?? 0;
    for (const [jobName, job] of Object.entries(yamlJobs(absolutePath))) {
      const isConfigurableQuality =
        workflowPath === CONFIGURABLE_RUNNER_WORKFLOW &&
        jobName === CONFIGURABLE_RUNNER_JOB_NAME;
      if (isConfigurableQuality) {
        qualityRunner = job['runs-on'];
      } else {
        const id = `${workflowPath}:${jobName}`;
        fixedRunnerJobs[id] = job['runs-on'];
        fixedRunnerJobDefinitions.push({
          definition: JSON.stringify(job),
          id,
        });
      }
    }
  }
  return {
    configurableRunnerOccurrences,
    fixedRunnerJobDefinitions,
    fixedRunnerJobs,
    qualityRunner,
    workflowPaths,
  };
};

const assertFixedRunnerJobsDoNotUseConfigurableRunner = (
  jobDefinitions: ReadonlyArray<{
    readonly definition: string;
    readonly id: string;
  }>,
): void => {
  const violations = jobDefinitions
    .filter(({ definition }) => definition.includes('vars.CI_RUNNER'))
    .map(({ id }) => id);
  if (violations.length > 0) {
    throw new Error(
      `Jobs must use a fixed runner, but these select vars.CI_RUNNER: ${violations.join(', ')}. Only ${CONFIGURABLE_RUNNER_JOB} may select vars.CI_RUNNER.`,
    );
  }
};

const productionWorkflowPaths = (
  workflowDirectory = join(ACTUAL_UPSTREAM, '.github/workflows'),
): ReadonlyArray<string> =>
  readdirSync(workflowDirectory, {
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && hasWorkflowExtension(entry.name))
    .map((entry) => join(workflowDirectory, entry.name));

const externalActionUses = (path: string): ReadonlyArray<string> =>
  Object.values(yamlJobs(path)).flatMap((job) => {
    const jobUses =
      typeof job.uses === 'string' && !job.uses.startsWith('./')
        ? [job.uses]
        : [];
    const { steps } = job;
    if (!Array.isArray(steps)) {
      return jobUses;
    }
    return [
      ...jobUses,
      ...steps.flatMap((step) => {
        if (
          typeof step !== 'object' ||
          step === null ||
          !('uses' in step) ||
          typeof step.uses !== 'string' ||
          step.uses.startsWith('./')
        ) {
          return [];
        }
        return [step.uses];
      }),
    ];
  });

const workflowTriggerNames = (path: string): ReadonlyArray<string> => {
  const parsedWorkflow: unknown = parseYaml(readFileSync(path, 'utf8'));
  if (
    typeof parsedWorkflow !== 'object' ||
    parsedWorkflow === null ||
    !('on' in parsedWorkflow) ||
    typeof parsedWorkflow.on !== 'object' ||
    parsedWorkflow.on === null
  ) {
    throw new Error(`${path} must declare event triggers`);
  }
  return Object.keys(parsedWorkflow.on);
};

const runWorkflowVersionGuard = (version: string): RunResult => {
  const fixture = mkTmp('sync-version-');
  write(
    fixture,
    'node_modules/@davidvornholt/standards/package.json',
    JSON.stringify({ version }),
  );
  return runExecutable(
    'bash',
    fixture,
    [
      '-euo',
      'pipefail',
      '-c',
      workflowRunScript('Require compatible standards CLI'),
    ],
    { MINIMUM_STANDARDS_VERSION: '0.21.0' },
  );
};

// A fake upstream: its own manifest, a `template/` seed dir, two managed files.
const buildUpstream = (paths: ReadonlyArray<string> = STD_PATHS): string => {
  const up = mkTmp('sync-up-');
  write(
    up,
    'sync-standards.json',
    JSON.stringify({ upstream: up, seedDir: 'template', paths }),
  );
  write(up, 'template/seed.txt', 'seed original\n');
  write(up, 'template/AGENTS.local.md', '# Local\n');
  write(up, 'template/biome.jsonc', '{"extends":["./biome.base.jsonc"]}\n');
  write(
    up,
    '.github/dependabot.base.yml',
    [
      'version: 2',
      'updates:',
      '  - package-ecosystem: bun',
      '    directory: /',
      '    schedule:',
      '      interval: weekly',
      '  - package-ecosystem: github-actions',
      '    directory: /',
      '    schedule:',
      '      interval: weekly',
      '',
    ].join('\n'),
  );
  write(up, 'template/.github/dependabot.local.yml', '# no additions yet\n');
  write(
    up,
    'template/package.json',
    JSON.stringify({
      workspaces: ['apps/*'],
      scripts: {
        standards: 'standards',
        check:
          'standards check && turbo run lint check-types test build test:a11y',
        'check:fix':
          'standards check && turbo run lint:fix check-types test build test:a11y',
      },
      devDependencies: { '@davidvornholt/standards': '0.1.0' },
    }),
  );
  write(
    up,
    'template/apps/web/package.json',
    JSON.stringify({
      name: '@repo/web',
      version: '0.0.0',
      scripts: {
        'check-types': 'tsc --noEmit',
        lint: 'biome check --error-on-warnings .',
        'lint:fix': 'biome check --write --error-on-warnings .',
        test: 'bun test',
      },
    }),
  );
  write(
    up,
    'template/apps/web/tsconfig.json',
    '{ "extends": "@davidvornholt/typescript-config/base" }\n',
  );
  write(up, 'managed/a.txt', 'alpha\n');
  write(up, 'managed/b.txt', 'beta\n');
  return up;
};
const initConsumer = (up: string): { consumer: string; result: RunResult } => {
  const consumer = mkTmp('sync-cons-');
  const result = run(consumer, ['init', '--from', up, '--dir', consumer]);
  return { consumer, result };
};
const sync = (
  up: string,
  consumer: string,
  extra: ReadonlyArray<string> = [],
): RunResult =>
  run(consumer, ['sync', ...extra, '--from', up, '--dir', consumer]);

const git = (dir: string, args: ReadonlyArray<string>): string =>
  execFileSync(
    'git',
    [
      '-C',
      dir,
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { encoding: 'utf8' },
  ).trim();

const exerciseSeededGitignore = (
  consumer: string,
): {
  ignoredOutput: string;
  ignoredPaths: ReadonlyArray<string>;
  lockIgnoreStatus: number;
} => {
  const ignoredPaths = [
    'node_modules/package/index.js',
    '.turbo/cache/state',
    'dist/app.js',
    '.next/server/app.js',
    'debug.log',
    '.claude/worktrees/task/src/wip.ts',
  ];
  for (const path of ignoredPaths) {
    write(consumer, path, 'ignored\n');
  }
  const unignoredPath = 'src/not-ignored.ts';
  write(consumer, unignoredPath, 'export {};\n');
  const emptyExcludes = join(consumer, '.git/test-empty-global-excludes');
  write(consumer, '.git/test-empty-global-excludes', '');
  const isolatedExcludes = ['-c', `core.excludesFile=${emptyExcludes}`];
  const ignoredOutput = git(consumer, [
    ...isolatedExcludes,
    'check-ignore',
    '--',
    ...ignoredPaths,
    unignoredPath,
  ]);
  const lockIgnoreStatus = runExecutable('git', consumer, [
    '-C',
    consumer,
    ...isolatedExcludes,
    'check-ignore',
    '--quiet',
    '--',
    'sync-standards.lock',
  ]).status;
  return { ignoredOutput, ignoredPaths, lockIgnoreStatus };
};

// A git-backed upstream with two commits: tag `v1` and branch `stable` hold
// the original managed content while `main` has moved on. `file://` forces the
// remote-source code path that a plain local path would bypass.
const buildGitUpstream = (): {
  up: string;
  url: string;
  taggedSha: string;
} => {
  const up = buildUpstream();
  git(up, ['init', '--quiet', '-b', 'main']);
  git(up, ['add', '-A']);
  git(up, ['commit', '--quiet', '-m', 'v1']);
  git(up, ['tag', 'v1']);
  git(up, ['branch', 'stable']);
  const taggedSha = git(up, ['rev-parse', 'HEAD']);
  write(up, 'managed/a.txt', 'alpha v2\n');
  git(up, ['add', '-A']);
  git(up, ['commit', '--quiet', '-m', 'v2']);
  return { up, url: `file://${up}`, taggedSha };
};

const buildDependabotCutoverUpstream = (): {
  up: string;
  url: string;
} => {
  const up = buildUpstream();
  const base = read(up, '.github/dependabot.base.yml');
  rmSync(join(up, '.github/dependabot.base.yml'));
  git(up, ['init', '--quiet', '-b', 'main']);
  git(up, ['add', '-A']);
  git(up, ['commit', '--quiet', '-m', 'v0.10.0']);
  git(up, ['tag', 'v0.10.0']);
  write(up, '.github/dependabot.base.yml', base);
  git(up, ['add', '-A']);
  git(up, ['commit', '--quiet', '-m', 'v0.10.1']);
  return { up, url: `file://${up}` };
};

afterEach(cleanupTmpDirs);

describe('init', () => {
  it('rejects a source without the canonical Dependabot base before seeding', () => {
    const up = buildUpstream();
    rmSync(join(up, '.github/dependabot.base.yml'));
    const consumer = mkTmp('sync-cons-');
    write(consumer, 'seed.txt', 'mine\n');
    const before = snapshotTree(consumer);

    const result = run(consumer, ['init', '--from', up, '--dir', consumer]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires a 0.10.1-compatible content ref');
    expect(snapshotTree(consumer)).toEqual(before);
  });

  it('validates the effective overlay seed before changing the consumer', () => {
    const up = buildUpstream();
    write(
      up,
      'template/.github/dependabot.local.yml',
      'updates:\n  - package-ecosystem: bun\n    directory: /\n    schedule: { interval: daily }\n',
    );
    const consumer = mkTmp('sync-cons-');
    write(consumer, 'owned.txt', 'unchanged\n');
    const before = snapshotTree(consumer);

    const result = run(consumer, ['init', '--from', up, '--dir', consumer]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'may only add ignore or registries entries',
    );
    expect(snapshotTree(consumer)).toEqual(before);
  });

  it('seeds a template-only file, mirrors managed files, writes lock', () => {
    const { consumer, result } = initConsumer(buildUpstream());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('seeded seed.txt');
    expect(result.stdout).toContain('init complete:');
    expect(read(consumer, 'seed.txt')).toBe('seed original\n');
    expect(result.stdout).toContain('generated .github/dependabot.yml');
    expect(read(consumer, '.github/dependabot.yml')).toStartWith(
      '# GENERATED FILE',
    );
    expect(read(consumer, '.github/dependabot.yml')).toContain(
      'package-ecosystem: "bun"',
    );
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(readLock(consumer).files['managed/a.txt']).toBeDefined();
  });

  it('never clobbers a pre-existing seed destination', () => {
    const up = buildUpstream();
    const consumer = mkTmp('sync-cons-');
    write(consumer, 'seed.txt', 'mine\n');
    const result = run(consumer, ['init', '--from', up, '--dir', consumer]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('kept seed.txt (already present)');
    expect(read(consumer, 'seed.txt')).toBe('mine\n');
  });

  it('refuses to re-initialize when a lock already exists', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    write(consumer, 'managed/a.txt', 'local edit\n');
    const again = run(consumer, ['init', '--from', up, '--dir', consumer]);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('already initialized');
    expect(read(consumer, 'managed/a.txt')).toBe('local edit\n');
  });

  it('errors when a managed path overlaps a seed target', () => {
    const { consumer, result } = initConsumer(buildUpstream(['seed.txt']));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('overlaps seed path');
    expect(existsSync(join(consumer, 'sync-standards.lock'))).toBe(false);
  });

  it('seeds the actual template with empty workspace roots', () => {
    const { consumer, result } = initConsumer(ACTUAL_UPSTREAM);
    expect(result.status).toBe(0);
    expect(run(consumer, ['structure', '--dir', consumer]).status).toBe(0);
    git(consumer, ['init', '--quiet']);
    git(consumer, [
      'remote',
      'add',
      'origin',
      'https://github.com/davidvornholt/standards.git',
    ]);
    const check = runExecutable(
      'bun',
      consumer,
      [ENGINE, 'check', '--dir', consumer],
      { STANDARDS_SKIP_GITHUB_CHECK: 'true' },
    );
    expect(check.status).toBe(0);
    expect(check.stdout).toContain(
      'live settings check skipped because STANDARDS_SKIP_GITHUB_CHECK=true',
    );
    expect(result.stdout).toContain('seeded .gitignore');
    expect(read(consumer, '.gitignore')).toBe(
      read(ACTUAL_UPSTREAM, 'template/.gitignore'),
    );
    const gitignore = exerciseSeededGitignore(consumer);
    expect(gitignore.ignoredOutput).toBe(gitignore.ignoredPaths.join('\n'));
    expect(gitignore.lockIgnoreStatus).toBe(1);
  });
});

describe('check', () => {
  it('passes right after init', () => {
    const { consumer } = initConsumer(buildUpstream());
    const check = run(consumer, ['check', '--dir', consumer]);
    expect(check.status).toBe(0);
    expect(check.stdout).toContain(
      'canonical path(s) match the last synced state',
    );
  });

  it('checks the raw Biome directive contract from the consumer lock', () => {
    const up = buildUpstream();
    write(
      up,
      'managed/a.txt',
      `documentation containing ${['biome', 'ignore'].join('-')}\n`,
    );
    const { consumer } = initConsumer(up);

    const check = run(consumer, ['check', '--dir', consumer]);

    expect(check.status).toBe(1);
    expect(check.stdout).toContain(
      'canonical path(s) match the last synced state',
    );
    expect(check.stderr).toContain(
      'canonical file(s) contain the forbidden inline Biome directive token',
    );
    expect(check.stderr).toContain('managed/a.txt');
  });

  it('fails and reports modified when a managed file is edited', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, 'managed/a.txt', 'tampered\n');
    const check = run(consumer, ['check', '--dir', consumer]);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain(
      'canonical path(s) drifted from the last synced state',
    );
    expect(check.stderr).toContain('modified: managed/a.txt');
  });

  it('fails and reports missing when a managed file is deleted', () => {
    const { consumer } = initConsumer(buildUpstream());
    rmSync(join(consumer, 'managed/a.txt'));
    const check = run(consumer, ['check', '--dir', consumer]);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('missing:  managed/a.txt');
  });

  it('fails closed when the lock is missing', () => {
    const consumer = mkTmp('sync-cons-');
    const check = run(consumer, ['check', '--dir', consumer]);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('no non-empty sync-standards.lock found');
  });

  it('aggregates malformed root JSON with independent gate problems', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, 'managed/a.txt', 'tampered\n');
    write(consumer, 'biome.jsonc', '{}\n');
    write(consumer, '.github/settings.json', '{"repository":{},"rulesets":[]}');
    write(
      consumer,
      '.github/settings.local.json',
      '{"repository":{},"rulesets":[]}',
    );
    write(consumer, 'package.json', '{ malformed');

    const check = run(import.meta.dir, ['check', '--dir', consumer]);

    expect(check.status).toBe(1);
    expect(check.stderr).toContain('modified: managed/a.txt');
    expect(check.stderr).toContain('biome.jsonc must extend');
    expect(check.stderr).toContain('package.json must contain valid JSON');
    expect(check.stderr).toContain(
      'package.json must exist and contain a JSON object',
    );
    expect(check.stderr).toContain(
      'cannot determine the GitHub repository from the origin remote',
    );
    expect(
      check.stderr.split('package.json must contain valid JSON'),
    ).toHaveLength(2);
    expect(check.stderr).not.toContain('JSON Parse error');
  });
});

describe('doctor', () => {
  it('reports every missing integration seam together', () => {
    const consumer = mkTmp('sync-cons-');
    write(consumer, 'package.json', '{}');
    const doctor = run(consumer, ['doctor', '--dir', consumer]);
    expect(doctor.status).toBe(1);
    expect(doctor.stderr).toContain('biome.jsonc must extend');
    expect(doctor.stderr).toContain('AGENTS.local.md must exist');
    expect(doctor.stderr).toContain('.github/dependabot.base.yml must exist');
    expect(doctor.stderr).toContain('@davidvornholt/standards');
    expect(doctor.stderr).toContain('script "check"');
    expect(doctor.stderr).toContain('script "check:fix"');
  });

  it('rejects non-executing standards check scripts', () => {
    const { consumer } = initConsumer(buildUpstream());
    const manifest = JSON.parse(read(consumer, 'package.json')) as {
      scripts: Record<string, string>;
    };
    manifest.scripts.check = 'echo standards check';
    manifest.scripts['check:fix'] = 'standards check --help';
    write(consumer, 'package.json', JSON.stringify(manifest));
    const doctor = run(consumer, ['doctor', '--dir', consumer]);
    expect(doctor.status).toBe(1);
    expect(doctor.stderr).toContain('script "check" must run standards check');
    expect(doctor.stderr).toContain(
      'script "check:fix" must run standards check',
    );
  });
});

describe('doctor Dependabot validation', () => {
  it('reports invalid Dependabot structure and missing baseline ecosystems', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(
      consumer,
      '.github/dependabot.base.yml',
      [
        'version: 1',
        'updates:',
        '  - package-ecosystem: nix',
        '    directory: /',
        '',
      ].join('\n'),
    );

    const doctor = run(consumer, ['doctor', '--dir', consumer]);

    expect(doctor.status).toBe(1);
    expect(doctor.stderr).toContain('must use version: 2');
    expect(doctor.stderr).toContain('must define schedule.interval');
    expect(doctor.stderr).toContain('root-directory bun ecosystem');
    expect(doctor.stderr).toContain('root-directory github-actions ecosystem');
  });

  it('reports malformed Dependabot YAML as an integration problem', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/dependabot.base.yml', 'version: [\n');

    const doctor = run(consumer, ['doctor', '--dir', consumer]);

    expect(doctor.status).toBe(1);
    expect(doctor.stderr).toContain(
      '.github/dependabot.base.yml must contain valid YAML',
    );
  });

  it('rejects unsupported and incomplete cron schedules', () => {
    const { consumer } = initConsumer(buildUpstream());
    const basePath = '.github/dependabot.base.yml';
    write(
      consumer,
      basePath,
      read(consumer, basePath)
        .replace('interval: weekly', 'interval: never')
        .replace('interval: weekly', 'interval: cron'),
    );

    const doctor = run(consumer, ['doctor', '--dir', consumer]);

    expect(doctor.status).toBe(1);
    expect(doctor.stderr).toContain('unsupported schedule.interval');
    expect(doctor.stderr).toContain('must define schedule.cronjob');
  });

  it('accepts additional ecosystems with a shared group schedule', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(
      consumer,
      '.github/dependabot.base.yml',
      [
        'version: 2',
        'multi-ecosystem-groups:',
        '  infrastructure:',
        '    schedule:',
        '      interval: weekly',
        'updates:',
        '  - package-ecosystem: bun',
        '    directory: /',
        '    schedule:',
        '      interval: weekly',
        '  - package-ecosystem: github-actions',
        '    directory: /',
        '    schedule:',
        '      interval: weekly',
        '  - package-ecosystem: nix',
        '    directories:',
        '      - /',
        '      - /infra',
        '    patterns: ["*"]',
        '    multi-ecosystem-group: infrastructure',
        '  - package-ecosystem: opentofu',
        '    directory: /infra',
        '    patterns: ["*"]',
        '    multi-ecosystem-group: infrastructure',
        '',
      ].join('\n'),
    );
    expect(
      run(consumer, ['dependabot', '--write', '--dir', consumer]).status,
    ).toBe(0);

    const doctor = run(consumer, ['doctor', '--dir', consumer]);

    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain('consumer integration seams are wired');
  });
});

describe('dependabot composition seam', () => {
  it('merges the repo-owned overlay into the generated file', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/dependabot.local.yml', DEPENDABOT_OVERLAY);

    const writeRun = run(consumer, [
      'dependabot',
      '--write',
      '--dir',
      consumer,
    ]);
    expect(writeRun.status).toBe(0);
    const generated = read(consumer, '.github/dependabot.yml');
    expect(generated).toContain('package-ecosystem: "nix"');
    expect(generated).toContain('dependency-name: "left-pad"');
    expect(run(consumer, ['doctor', '--dir', consumer]).status).toBe(0);
  });

  it('rejects an overlay that overrides a canonical block', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(
      consumer,
      '.github/dependabot.local.yml',
      [
        'updates:',
        '  - package-ecosystem: bun',
        '    directory: /',
        '    schedule:',
        '      interval: daily',
        '',
      ].join('\n'),
    );

    const writeRun = run(consumer, [
      'dependabot',
      '--write',
      '--dir',
      consumer,
    ]);
    expect(writeRun.status).toBe(1);
    expect(writeRun.stderr).toContain(
      'may only add ignore or registries entries',
    );
    const doctor = run(consumer, ['doctor', '--dir', consumer]);
    expect(doctor.status).toBe(1);
    expect(doctor.stderr).toContain(
      'may only add ignore or registries entries',
    );
  });

  it('flags a hand-edited generated file and repairs it with --write', () => {
    const { consumer } = initConsumer(buildUpstream());
    const before = read(consumer, '.github/dependabot.yml');
    write(consumer, '.github/dependabot.yml', `${before}# hand edit\n`);

    const check = run(consumer, ['dependabot', '--check', '--dir', consumer]);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('does not match its composed sources');
    expect(run(consumer, ['doctor', '--dir', consumer]).status).toBe(1);

    expect(
      run(consumer, ['dependabot', '--write', '--dir', consumer]).status,
    ).toBe(0);
    expect(read(consumer, '.github/dependabot.yml')).toBe(before);
    expect(run(consumer, ['dependabot', '--dir', consumer]).status).toBe(0);
  });

  it('regenerates the composed file on sync after the overlay changes', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    write(consumer, '.github/dependabot.local.yml', DEPENDABOT_OVERLAY);

    const dry = run(consumer, [
      'sync',
      '--from',
      up,
      '--dir',
      consumer,
      '--dry-run',
    ]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('would generate .github/dependabot.yml');
    expect(dry.stdout).not.toContain('already in sync; no changes');
    expect(dry.stdout).toContain('0 to delete, 1 to generate');
    expect(read(consumer, '.github/dependabot.yml')).not.toContain('nix');

    const syncRun = run(consumer, ['sync', '--from', up, '--dir', consumer]);
    expect(syncRun.status).toBe(0);
    expect(syncRun.stdout).toContain('generated .github/dependabot.yml');
    expect(read(consumer, '.github/dependabot.yml')).toContain(
      'package-ecosystem: "nix"',
    );
  });
});

describe('structure', () => {
  const tsconfigProblem =
    'apps/web: tsconfig.json must extend @davidvornholt/typescript-config';

  it('check rejects non-executing root gate modes', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(
      consumer,
      'package.json',
      JSON.stringify({
        workspaces: ['apps/*'],
        scripts: {
          check:
            'standards check && turbo run lint check-types test build test:a11y --dry',
          'check:fix':
            'standards check && turbo run lint:fix check-types test build test:a11y --version',
        },
        devDependencies: { '@davidvornholt/standards': '0.1.0' },
      }),
    );
    const check = run(consumer, ['check', '--dir', consumer]);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('monorepo structure problem(s)');
    expect(check.stderr).toContain('root script "check" must run');
    expect(check.stderr).toContain('root script "check:fix" must run');
  });

  it('the structure command validates structure in isolation', () => {
    const { consumer } = initConsumer(buildUpstream());
    const ok = run(consumer, ['structure', '--dir', consumer]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('workspace layout matches the standards');
  });

  it('the source checkout passes its own source profile', () => {
    const result = run(ACTUAL_UPSTREAM, [
      'structure',
      '--profile',
      'source',
      '--dir',
      ACTUAL_UPSTREAM,
    ]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('rejects an unknown structure profile', () => {
    const consumer = mkTmp('sync-cons-');
    const result = run(consumer, ['structure', '--profile', 'strict']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--profile must be "consumer" or "source"');
  });

  it('rejects --profile outside the structure command', () => {
    const consumer = mkTmp('sync-cons-');
    const result = run(consumer, ['doctor', '--profile', 'source']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '--profile is only valid with the structure command',
    );
  });

  it.each([
    [
      'commented-out',
      '{ // "extends": "@davidvornholt/typescript-config/base"\n}',
    ],
    [
      'nested',
      '{"compilerOptions":{"extends":"@davidvornholt/typescript-config/base"}}',
    ],
    ['lookalike scope', '{"extends":"@other/typescript-config/base"}'],
    [
      'lookalike name',
      '{"extends":"@davidvornholt/typescript-config-copy/base"}',
    ],
    ['empty export', '{"extends":"@davidvornholt/typescript-config/"}'],
    [
      'traversal export',
      '{"extends":"@davidvornholt/typescript-config/../evil"}',
    ],
    ['malformed', '{"extends":"@davidvornholt/typescript-config/base"'],
  ])('rejects %s tsconfig inheritance', (_label, tsconfig) => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, 'apps/web/tsconfig.json', tsconfig);
    const result = run(consumer, ['structure', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(tsconfigProblem);
  });

  it.each([
    [
      'JSONC string',
      '{ // shared strict defaults\n"extends":"@davidvornholt/typescript-config/base",\n}',
    ],
    [
      'extends array',
      '{"extends":["./generated.json","@davidvornholt/typescript-config/next"]}',
    ],
  ])('accepts canonical inheritance through a %s', (_label, tsconfig) => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, 'apps/web/tsconfig.json', tsconfig);
    expect(run(consumer, ['structure', '--dir', consumer]).status).toBe(0);
  });
});

describe('prospective Dependabot sync', () => {
  it('rejects an incoming source without the Dependabot base before mutation', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    rmSync(join(up, '.github/dependabot.base.yml'));
    write(up, 'managed/a.txt', 'alpha v2\n');
    const before = snapshotTree(consumer);

    const result = sync(up, consumer);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires a 0.10.1-compatible content ref');
    expect(snapshotTree(consumer)).toEqual(before);
  });

  it('validates an incoming base against the overlay before every mutation', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    write(
      consumer,
      '.github/dependabot.local.yml',
      [
        'updates:',
        '  - package-ecosystem: nix',
        '    directory: /',
        '    schedule: { interval: weekly }',
        '',
      ].join('\n'),
    );
    write(up, 'managed/a.txt', 'alpha v2\n');
    rmSync(join(up, 'managed/b.txt'));
    write(up, 'managed/new.txt', 'new\n');
    write(
      up,
      '.github/dependabot.base.yml',
      `${read(up, '.github/dependabot.base.yml')}  - package-ecosystem: nix\n    directory: /\n    schedule: { interval: weekly }\n`,
    );
    const before = snapshotTree(consumer);

    const dry = sync(up, consumer, ['--dry-run']);
    const real = sync(up, consumer);

    expect(dry.status).toBe(1);
    expect(real.status).toBe(1);
    expect(dry.stderr).toContain('may only add ignore or registries entries');
    expect(real.stderr).toContain('may only add ignore or registries entries');
    expect(snapshotTree(consumer)).toEqual(before);
  });

  it('dry-run composes the incoming base and reports its generated change', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    const before = snapshotTree(consumer);
    write(
      up,
      '.github/dependabot.base.yml',
      `${read(up, '.github/dependabot.base.yml')}  - package-ecosystem: nix\n    directory: /\n    schedule: { interval: weekly }\n`,
    );

    const dry = sync(up, consumer, ['--dry-run']);

    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('would update .github/dependabot.base.yml');
    expect(dry.stdout).toContain('would generate .github/dependabot.yml');
    expect(dry.stdout).toContain(
      'dry run: 0 to create, 1 to update, 0 to delete, 1 to generate',
    );
    expect(snapshotTree(consumer)).toEqual(before);
  });
});

describe('sync', () => {
  it('uses new managed paths from the upstream manifest immediately', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    write(up, 'newly-managed.txt', 'new\n');
    write(
      up,
      'sync-standards.json',
      JSON.stringify({
        upstream: up,
        seedDir: 'template',
        paths: [...STD_PATHS, 'newly-managed.txt'],
      }),
    );

    const result = sync(up, consumer);

    expect(result.status).toBe(0);
    expect(read(consumer, 'newly-managed.txt')).toBe('new\n');
    expect(readLock(consumer).files['newly-managed.txt']).toBeDefined();
    expect(sync(up, consumer, ['--dry-run']).stdout).toContain(
      'dry run: already in sync; no changes',
    );
  });

  it('deletes a consumer file removed from upstream and prunes the lock', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    rmSync(join(up, 'managed/b.txt'));
    const result = sync(up, consumer);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('deleted managed/b.txt (removed upstream)');
    expect(existsSync(join(consumer, 'managed/b.txt'))).toBe(false);
    expect(readLock(consumer).files['managed/b.txt']).toBeUndefined();
  });

  it('updates a changed upstream file and check passes afterward', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    write(up, 'managed/a.txt', 'alpha v2\n');
    const result = sync(up, consumer);
    expect(result.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha v2\n');
    expect(run(consumer, ['check', '--dir', consumer]).status).toBe(0);
  });

  it('dry-run writes nothing, then a real sync applies the change', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    const lockBefore = read(consumer, 'sync-standards.lock');
    write(up, 'managed/a.txt', 'alpha v2\n');
    const dry = sync(up, consumer, ['--dry-run']);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('would update managed/a.txt');
    expect(dry.stdout).toContain(
      'dry run: 0 to create, 1 to update, 0 to delete, 0 to generate',
    );
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
    sync(up, consumer);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha v2\n');
  });

  it('dry-run reports no changes when already in sync', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    const dry = sync(up, consumer, ['--dry-run']);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('dry run: already in sync; no changes');
  });
});

describe('Dependabot content ref cutover', () => {
  it('rejects the v0.10.0 pinned ref before init or sync mutation', () => {
    const { up, url } = buildDependabotCutoverUpstream();

    const initTarget = mkTmp('sync-cons-');
    write(initTarget, 'owned.txt', 'unchanged\n');
    const initBefore = snapshotTree(initTarget);
    const initResult = run(initTarget, [
      'init',
      '--from',
      url,
      '--ref',
      'v0.10.0',
      '--dir',
      initTarget,
    ]);
    expect(initResult.status).toBe(1);
    expect(initResult.stderr).toContain(
      'requires a 0.10.1-compatible content ref',
    );
    expect(snapshotTree(initTarget)).toEqual(initBefore);

    const { consumer } = initConsumer(up);
    const syncBefore = snapshotTree(consumer);
    const syncResult = sync(url, consumer, ['--ref', 'v0.10.0']);
    expect(syncResult.status).toBe(1);
    expect(syncResult.stderr).toContain(
      'requires a 0.10.1-compatible content ref',
    );
    expect(snapshotTree(consumer)).toEqual(syncBefore);
  });
});

describe('ref pinning', () => {
  it('syncs the tagged snapshot with --ref and main without it', () => {
    const { up, url, taggedSha } = buildGitUpstream();
    const { consumer } = initConsumer(up);

    const pinned = sync(url, consumer, ['--ref', 'v1']);
    expect(pinned.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(readLock(consumer).sha).toBe(taggedSha);

    const tracking = sync(url, consumer);
    expect(tracking.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha v2\n');
  });

  it('syncs a raw commit sha and records the exact pin', () => {
    const { up, url, taggedSha } = buildGitUpstream();
    const { consumer } = initConsumer(up);

    const result = sync(url, consumer, ['--ref', taggedSha]);

    expect(result.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(readLock(consumer).sha).toBe(taggedSha);
  });

  it('syncs a named non-default branch', () => {
    const { up, url, taggedSha } = buildGitUpstream();
    const { consumer } = initConsumer(up);

    const result = sync(url, consumer, ['--ref', 'stable']);

    expect(result.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(readLock(consumer).sha).toBe(taggedSha);
  });

  it('init honors --ref for a pinned first mirror', () => {
    const { url, taggedSha } = buildGitUpstream();
    const consumer = mkTmp('sync-cons-');
    const result = run(consumer, [
      'init',
      '--from',
      url,
      '--ref',
      'v1',
      '--dir',
      consumer,
    ]);
    expect(result.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(readLock(consumer).sha).toBe(taggedSha);
  });

  it('fails with an actionable error for an unknown ref', () => {
    const { up, url } = buildGitUpstream();
    const { consumer } = initConsumer(up);
    const result = sync(url, consumer, ['--ref', 'v9']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Cannot fetch "v9"');
  });

  it('rejects an option-like ref without changing the consumer', () => {
    const { up, url } = buildGitUpstream();
    const { consumer } = initConsumer(up);
    const managedBefore = read(consumer, 'managed/a.txt');
    const lockBefore = read(consumer, 'sync-standards.lock');

    const result = sync(url, consumer, ['--ref', '-u']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Cannot fetch "-u"');
    expect(read(consumer, 'managed/a.txt')).toBe(managedBefore);
    expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
  });

  it('rejects --ref combined with a local path source', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    const result = sync(up, consumer, ['--ref', 'v1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--ref requires a git URL source');
  });

  it('rejects --ref outside init and sync', () => {
    const consumer = mkTmp('sync-cons-');
    const result = run(consumer, ['check', '--ref', 'v1', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '--ref is only valid with the init and sync commands',
    );
  });
});

describe('sync policy file', () => {
  it('sync honors a checked-in pin and an explicit --ref overrides it', () => {
    const { up, url, taggedSha } = buildGitUpstream();
    const { consumer } = initConsumer(up);
    write(consumer, 'sync-standards.local.json', '{ "ref": "v1" }\n');

    const pinned = sync(url, consumer);
    expect(pinned.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(readLock(consumer).sha).toBe(taggedSha);

    const overridden = sync(url, consumer, ['--ref', 'main']);
    expect(overridden.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha v2\n');
  });

  it('init honors a checked-in pin for the first mirror', () => {
    const { url, taggedSha } = buildGitUpstream();
    const consumer = mkTmp('sync-cons-');
    write(consumer, 'sync-standards.local.json', '{ "ref": "v1" }\n');
    const result = run(consumer, ['init', '--from', url, '--dir', consumer]);
    expect(result.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(readLock(consumer).sha).toBe(taggedSha);
  });

  it('ignores the pin for a local-path source, which is used as-is', () => {
    const { up } = buildGitUpstream();
    const { consumer } = initConsumer(up);
    write(consumer, 'sync-standards.local.json', '{ "ref": "v1" }\n');
    const result = sync(up, consumer);
    expect(result.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha v2\n');
  });
});

describe('sync policy validation', () => {
  it.each(
    INVALID_POLICY_CASES,
  )('validates %s before explicit refs and local sources', (_label, policy, expectedError) => {
    const { up, url } = buildGitUpstream();
    const { consumer } = initConsumer(up);
    write(consumer, 'sync-standards.local.json', policy);

    for (const extra of [
      ['--ref', 'main'],
      ['--ref', 'main', '--dry-run'],
    ]) {
      const result = sync(url, consumer, extra);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(expectedError);
    }

    const localSync = sync(up, consumer);
    expect(localSync.status).toBe(1);
    expect(localSync.stderr).toContain(expectedError);

    for (const source of [url, up]) {
      const initTarget = mkTmp('sync-cons-');
      write(initTarget, 'sync-standards.local.json', policy);
      const args =
        source === url
          ? ['init', '--from', source, '--ref', 'main', '--dir', initTarget]
          : ['init', '--from', source, '--dir', initTarget];
      const result = run(initTarget, args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(expectedError);
    }
  });

  it.each(
    INVALID_POLICY_CASES,
  )('doctor and check reject %s', (_label, policy, expectedError) => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, 'sync-standards.local.json', policy);

    for (const command of ['doctor', 'check']) {
      const result = run(consumer, [command, '--dir', consumer]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(expectedError);
    }
  });

  it('doctor and check accept a valid policy', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(
      consumer,
      'sync-standards.local.json',
      '{ "autoSync": false, "ref": "v1" }\n',
    );

    expect(run(consumer, ['doctor', '--dir', consumer]).status).toBe(0);
    expect(run(consumer, ['check', '--dir', consumer]).status).toBe(0);
  });
});

type PackedCliInstallation = {
  readonly consumer: string;
  readonly help: RunResult;
  readonly sourceProfile: RunResult;
};

type ExecutableRunner = typeof runExecutable;

const requireSuccessfulStage = (stage: string, result: RunResult): void => {
  if (result.status !== 0) {
    throw new Error(`${stage} failed: ${result.stderr}`);
  }
};

const installPackedCli = (
  execute: ExecutableRunner = runExecutable,
): PackedCliInstallation => {
  const packed = mkTmp('standards-pack-');
  const pack = execute('bun', join(import.meta.dir, '..'), [
    'pm',
    'pack',
    '--destination',
    packed,
    '--quiet',
  ]);
  requireSuccessfulStage('pack', pack);
  const tarball = pack.stdout.trim();
  if (tarball.length === 0) {
    throw new Error('pack succeeded without reporting a tarball');
  }

  const consumer = mkTmp('sync-cons-');
  write(
    consumer,
    'package.json',
    JSON.stringify({
      version: '0.0.0',
      private: true,
      workspaces: ['apps/*'],
      scripts: {
        standards: 'standards',
        check:
          'standards check && turbo run lint check-types test build test:a11y',
        'check:fix':
          'standards check && turbo run lint:fix check-types test build test:a11y',
      },
      devDependencies: {
        '@davidvornholt/standards': `file:${tarball}`,
      },
    }),
  );
  const install = execute('bun', consumer, ['install', '--ignore-scripts']);
  requireSuccessfulStage('install', install);

  const help = execute('bun', consumer, ['standards', 'help']);
  const sourceProfile = execute('bun', consumer, [
    'standards',
    'structure',
    '--profile',
    'source',
    '--dir',
    ACTUAL_UPSTREAM,
  ]);
  return { consumer, help, sourceProfile };
};

describe('packed artifact prerequisite staging', () => {
  it.each([
    ['pack', 1],
    ['install', 2],
  ] as const)('does not execute later stages after %s fails', (_stage, failureCall) => {
    let calls = 0;
    const execute: ExecutableRunner = () => {
      calls += 1;
      return {
        stdout: calls === 1 ? '/tmp/standards.tgz\n' : '',
        stderr: '',
        status: calls === failureCall ? 1 : 0,
      };
    };

    expect(() => installPackedCli(execute)).toThrow();
    expect(calls).toBe(failureCall);
  });
});

describe('packed artifact content ref cutover', () => {
  it('rejects v0.10.0 content before packed init or sync mutation', () => {
    const { consumer: runner } = installPackedCli();
    const { up, url } = buildDependabotCutoverUpstream();
    const execute = (args: ReadonlyArray<string>, target: string): RunResult =>
      runExecutable('bun', runner, ['standards', ...args, '--dir', target]);

    const initTarget = mkTmp('sync-cons-');
    write(initTarget, 'owned.txt', 'unchanged\n');
    const initBefore = snapshotTree(initTarget);
    const initResult = execute(
      ['init', '--from', url, '--ref', 'v0.10.0'],
      initTarget,
    );
    expect(initResult.status).toBe(1);
    expect(initResult.stderr).toContain(
      'requires a 0.10.1-compatible content ref',
    );
    expect(snapshotTree(initTarget)).toEqual(initBefore);

    const syncTarget = mkTmp('sync-cons-');
    expect(execute(['init', '--from', up], syncTarget).status).toBe(0);
    const syncBefore = snapshotTree(syncTarget);
    const syncResult = execute(
      ['sync', '--from', url, '--ref', 'v0.10.0'],
      syncTarget,
    );
    expect(syncResult.status).toBe(1);
    expect(syncResult.stderr).toContain(
      'requires a 0.10.1-compatible content ref',
    );
    expect(snapshotTree(syncTarget)).toEqual(syncBefore);
  });
});

describe('packed artifact token contract', () => {
  it('enforces the canonical token contract from a consumer lock', () => {
    const { consumer: runner } = installPackedCli();
    const upstream = buildUpstream();
    write(
      upstream,
      'managed/a.txt',
      `documentation containing ${['biome', 'ignore'].join('-')}\n`,
    );
    const consumer = mkTmp('sync-cons-');
    expect(
      runExecutable('bun', runner, [
        'standards',
        'init',
        '--from',
        upstream,
        '--dir',
        consumer,
      ]).status,
    ).toBe(0);

    const check = runExecutable('bun', runner, [
      'standards',
      'check',
      '--dir',
      consumer,
    ]);

    expect(check.status).toBe(1);
    expect(check.stdout).toContain(
      'canonical path(s) match the last synced state',
    );
    expect(check.stderr).toContain(
      'canonical file(s) contain the forbidden inline Biome directive token',
    );
    expect(check.stderr).toContain('managed/a.txt');
  });
});

describe('packed artifact distribution', () => {
  it('ships the Dependabot contract and honors the workflow sync pin', () => {
    const packageManifest = JSON.parse(
      readFileSync(join(import.meta.dir, '../package.json'), 'utf8'),
    ) as { version: string };
    const templateManifest = JSON.parse(
      readFileSync(join(ACTUAL_UPSTREAM, 'template/package.json'), 'utf8'),
    ) as { devDependencies: Record<string, string> };
    expect(templateManifest.devDependencies['@davidvornholt/standards']).toBe(
      packageManifest.version,
    );
    const installation = installPackedCli();
    expect(installation.help.status).toBe(0);
    expect(installation.help.stdout).toContain(
      'dependabot  Verify (--check) or regenerate (--write)',
    );
    expect(installation.sourceProfile.stderr).toBe('');
    expect(installation.sourceProfile.status).toBe(0);
    const { consumer } = installation;
    const installedSettingsParser = runExecutable('bun', consumer, [
      '-e',
      [
        `import { loadGithubSettings } from ${JSON.stringify(join(consumer, 'node_modules/@davidvornholt/standards/src/github-settings.ts'))};`,
        'const loaded = loadGithubSettings(',
        '  JSON.stringify({ repository: {}, rulesets: [], labels: [{ name: "approved-for-fix", color: "0e8a16", description: "Approved" }] }),',
        '  JSON.stringify({ repository: {}, rulesets: [], labels: [] }),',
        ');',
        'if (loaded.merged?.labels[0]?.name !== "approved-for-fix" || loaded.problems.length !== 0) process.exit(1);',
      ].join('\n'),
    ]);
    expect(installedSettingsParser.stderr).toBe('');
    expect(installedSettingsParser.status).toBe(0);

    const { up, url } = buildGitUpstream();
    const command = (name: 'check' | 'dependabot'): RunResult =>
      runExecutable('bun', consumer, [
        'standards',
        name,
        ...(name === 'dependabot' ? ['--check'] : []),
        '--dir',
        consumer,
      ]);
    expect(
      runExecutable('bun', consumer, [
        'standards',
        'init',
        '--from',
        up,
        '--dir',
        consumer,
      ]).status,
    ).toBe(0);
    write(consumer, '.github/dependabot.local.yml', DEPENDABOT_OVERLAY);
    expect(
      runExecutable('bun', consumer, [
        'standards',
        'dependabot',
        '--write',
        '--dir',
        consumer,
      ]).status,
    ).toBe(0);
    const composed = read(consumer, '.github/dependabot.yml');
    expect(composed).toContain('package-ecosystem: "nix"');
    expect(composed).toContain('dependency-name: "left-pad"');
    expect(command('dependabot').status).toBe(0);
    write(consumer, '.github/dependabot.yml', `${composed}# generated drift\n`);
    for (const driftCheck of (['dependabot', 'check'] as const).map(command)) {
      expect(driftCheck.status).toBe(1);
      expect(driftCheck.stderr).toContain(
        'does not match its composed sources',
      );
    }
    write(consumer, 'sync-standards.local.json', '{ "ref": "v1" }\n');
    expect(
      runExecutable('bun', consumer, [
        'standards',
        'sync',
        '--from',
        url,
        '--dir',
        consumer,
      ]).status,
    ).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(read(consumer, '.github/dependabot.yml')).toBe(composed);
    expect(command('check').status).toBe(0);
  });
});

describe('canonical standards workflow security boundaries', () => {
  it('declares squash as the only supported merge method at both enforcement layers', () => {
    const declaration = JSON.parse(
      readFileSync(join(ACTUAL_UPSTREAM, '.github/settings.json'), 'utf8'),
    ) as {
      readonly repository: Readonly<Record<string, unknown>>;
      readonly rulesets: ReadonlyArray<Readonly<Record<string, unknown>>>;
    };
    const protectMain = declaration.rulesets.find(
      (ruleset) => ruleset.name === 'Protect main',
    );
    const rules = Array.isArray(protectMain?.rules)
      ? protectMain.rules.filter(
          (rule): rule is Readonly<Record<string, unknown>> =>
            typeof rule === 'object' && rule !== null,
        )
      : [];
    const pullRequest = rules.find((rule) => rule.type === 'pull_request');

    expect(declaration.repository).toMatchObject({
      allow_merge_commit: false,
      allow_rebase_merge: false,
      allow_squash_merge: true,
    });
    expect(pullRequest?.parameters).toMatchObject({
      allowed_merge_methods: ['squash'],
    });
  });

  it('enumerates exactly the known production workflow files', () => {
    // Pin the enumerated set, not just its size. This enumeration shares one
    // workflow-file predicate with the canonical runner-boundary ratchet, so a
    // narrowing made for that one must fail here instead of silently dropping a
    // workflow — publish-standards-cli.yml above all — out of every check that
    // walks production workflows.
    expect(
      productionWorkflowPaths()
        .map((path) => relative(ACTUAL_UPSTREAM, path))
        .toSorted(),
      'The production workflow inventory no longer matches this list. If you added a workflow, add its path to the expected list below. If a path went missing, the shared workflow-file predicate stopped matching it and the workflow has fallen out of these security checks — restore the predicate instead of editing the list.',
    ).toEqual([
      '.github/workflows/notify-pause.yml',
      '.github/workflows/publish-standards-cli.yml',
      '.github/workflows/standards-sync.yml',
      '.github/workflows/standards.yml',
    ]);
  });

  it('uses major-version tags for every external action in every production workflow', () => {
    const uses = productionWorkflowPaths().flatMap(externalActionUses);

    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) {
      expect(use).toMatch(MAJOR_ACTION_REF);
    }
  });

  it.each([
    [
      'full-SHA step-level action',
      [
        'jobs:',
        '  fixture:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: owner/action@0123456789abcdef0123456789abcdef01234567',
        '',
      ].join('\n'),
    ],
    [
      'branch-pinned job-level reusable workflow',
      [
        'jobs:',
        '  fixture:',
        '    uses: owner/repo/.github/workflows/check.yml@main',
        '',
      ].join('\n'),
    ],
  ])('detects a non-major-tag %s', (_label, workflow) => {
    const fixture = mkTmp('workflow-action-version-policy-');
    const path = join(fixture, 'fixture.yml');
    write(fixture, 'fixture.yml', workflow);

    expect(externalActionUses(path)).toHaveLength(1);
    expect(externalActionUses(path)[0]).not.toMatch(MAJOR_ACTION_REF);
  });

  it('includes .yaml workflows in the production action-version ratchet', () => {
    const fixture = mkTmp('workflow-action-version-policy-yaml-');
    write(
      fixture,
      'release.yaml',
      [
        'jobs:',
        '  publish:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: owner/action@main',
        '',
      ].join('\n'),
    );

    const uses = productionWorkflowPaths(fixture).flatMap(externalActionUses);
    expect(uses).toEqual(['owner/action@main']);
    expect(uses[0]).not.toMatch(MAJOR_ACTION_REF);
  });
});

const SETTINGS_CHECK_STEP_NAMES = [
  'Checkout settings inputs',
  'Install pinned settings checker',
  'Check GitHub settings',
  'Require all standards gates',
] as const;
const SETTINGS_SKIP_ENVIRONMENT = 'STANDARDS_SKIP_GITHUB_CHECK';

const requireExactWorkflowValue = (
  actual: unknown,
  expected: unknown,
  message: string,
): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message);
  }
};

const settingsSkipBindings = (
  workflow: ParsedWorkflow,
): ReadonlyArray<{ readonly location: string; readonly value: unknown }> => {
  const bindings: Array<{
    readonly location: string;
    readonly value: unknown;
  }> = [];
  const recordBinding = (env: unknown, location: string): void => {
    if (
      typeof env === 'object' &&
      env !== null &&
      SETTINGS_SKIP_ENVIRONMENT in env
    ) {
      bindings.push({
        location,
        value: (env as Record<string, unknown>)[SETTINGS_SKIP_ENVIRONMENT],
      });
    }
  };

  recordBinding(workflow.env, 'workflow.env');
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    recordBinding(job.env, `jobs.${jobName}.env`);
    for (const [index, step] of workflowSteps(job, jobName).entries()) {
      const stepName = typeof step.name === 'string' ? step.name : `${index}`;
      recordBinding(step.env, `jobs.${jobName}.steps.${stepName}.env`);
    }
  }
  return bindings;
};

const assertSettingsTrustBoundary = (
  workflow: ParsedWorkflow,
): ReadonlyArray<WorkflowStep> => {
  const checkSteps = workflowSteps(workflow.jobs.check, 'check');
  requireExactWorkflowValue(
    checkSteps.map((step) => step.name),
    SETTINGS_CHECK_STEP_NAMES,
    'The check job must contain only the four trusted steps in order',
  );

  const [checkoutStep] = checkSteps;
  requireExactWorkflowValue(
    checkoutStep?.uses,
    'actions/checkout@v7',
    'The check job must use the canonical checkout action',
  );
  requireExactWorkflowValue(
    sparseCheckoutPaths(checkoutStep ?? {}),
    ['.github/settings.json', '.github/settings.local.json'],
    'The check job may check out only declarative settings inputs',
  );
  requireExactWorkflowValue(
    checkoutStep?.with,
    {
      'persist-credentials': false,
      'sparse-checkout': '.github/settings.json\n.github/settings.local.json\n',
      'sparse-checkout-cone-mode': false,
    },
    'The check job checkout must stay sparse and credential-free',
  );
  requireExactWorkflowValue(
    settingsSkipBindings(workflow),
    [
      {
        location: 'jobs.quality.steps.Check.env',
        value: 'true',
      },
    ],
    'Only the quality Check step may skip its nested GitHub settings check',
  );
  return checkSteps;
};

describe('canonical standards workflow settings security', () => {
  it('isolates the settings comparison from repository-controlled executable code', () => {
    const workflowSource = readFileSync(STANDARDS_WORKFLOW, 'utf8');
    const workflow = parseWorkflow(STANDARDS_WORKFLOW);
    const settingsJobSource = JSON.stringify(workflow.jobs.check);
    const [, installStep, settingsStep] = assertSettingsTrustBoundary(workflow);
    const installRun = String(installStep?.run);
    const settingsRun = String(settingsStep?.run);

    // The job holds no durable credential, so it needs no executable file from
    // the repository at all: declarative settings inputs and nothing else.
    expect(settingsJobSource).not.toContain('GITHUB_ENV');
    expect(workflowSource).not.toContain('GH_TOKEN:');
    expect(settingsRun).not.toContain('GITHUB_OUTPUT');
    expect(settingsRun).toContain('GH_TOKEN="$SETTINGS_TOKEN"');
    // An empty or multi-line token must stop the job rather than reach the CLI,
    // where an empty GH_TOKEN would silently downgrade to anonymous reads.
    expect(settingsRun).toContain('exit 1');
    expect(settingsRun).toContain(
      '[ -z "$SETTINGS_TOKEN" ] || [[ "$SETTINGS_TOKEN" == *$\'\\n\'* ]] || [[ "$SETTINGS_TOKEN" == *$\'\\r\'* ]]',
    );
    expect(installRun).toContain('bun_version=1.3.14');
    expect(installRun.match(/bun_sha=[a-f0-9]{64}/gu)).toHaveLength(2);
    expect(installRun).toContain('standards_version=0.21.0');
    expect(installRun).toContain(
      'standards_sha=afb8576434e62730e06d30d8249b1d275f586a874826ad7b50fe5e4d1b32b0da0e4adea176c6151160fc50a8ac049bab91095d18867b2a2544f40408f9e8f8ff',
    );
    expect(installRun).toContain('yaml_version=2.9.0');
    expect(installRun.match(/sha=[a-f0-9]{128}/gu)).toHaveLength(2);
    expect(installRun).toContain('sha512sum --check --quiet');
    expect(installRun).not.toContain('bun add');
    expect(settingsRun).not.toContain('SOPS_AGE_KEY');
  });

  it('rejects a full checkout or a hoisted quality-check skip seam', () => {
    const fullCheckoutWorkflow = structuredClone(
      parseWorkflow(STANDARDS_WORKFLOW),
    );
    const [fullCheckoutStep] = workflowSteps(
      fullCheckoutWorkflow.jobs.check,
      'check',
    );
    if (fullCheckoutStep !== undefined) {
      fullCheckoutStep.with = undefined;
    }
    expect(() => assertSettingsTrustBoundary(fullCheckoutWorkflow)).toThrow();

    const hoistedSkipWorkflow = structuredClone(
      parseWorkflow(STANDARDS_WORKFLOW),
    );
    hoistedSkipWorkflow.env = { [SETTINGS_SKIP_ENVIRONMENT]: 'true' };
    expect(() => assertSettingsTrustBoundary(hoistedSkipWorkflow)).toThrow();
  });

  it('pins the isolated settings checker to the sync workflow minimum', () => {
    const [, installStep] = assertSettingsTrustBoundary(
      parseWorkflow(STANDARDS_WORKFLOW),
    );
    const installRun = String(installStep?.run);
    const syncWorkflow = readFileSync(SYNC_WORKFLOW, 'utf8');
    const pinnedVersion = installRun.match(PINNED_STANDARDS_VERSION_PATTERN)
      ?.groups?.version;
    const minimumVersion = syncWorkflow.match(MINIMUM_STANDARDS_VERSION_PATTERN)
      ?.groups?.version;

    expect(pinnedVersion).toBeDefined();
    expect(minimumVersion).toBeDefined();
    expect(pinnedVersion).toBe(minimumVersion);
  });
});

describe('canonical standards workflow settings credential', () => {
  it('reads settings with the workflow token and no durable credential', () => {
    const workflow = readFileSync(STANDARDS_WORKFLOW, 'utf8');
    const [, , settingsStep] = assertSettingsTrustBoundary(
      parseWorkflow(STANDARDS_WORKFLOW),
    );
    const settingsRun = String(settingsStep?.run);

    // A probe against a private repository compared a broker App installation
    // token against a token holding exactly this job's grants across every read
    // the gate performs, and the answers were identical. Minting therefore adds
    // no visibility, so the gate must not decrypt the durable App key: doing so
    // would put the one credential every consumer keeps for the weekly sync
    // into a job that gains nothing from it.
    expect(settingsStep?.env).toEqual({
      SETTINGS_TOKEN: githubExpression('github.token'),
    });
    expect(workflow).not.toContain('sops-secret');
    expect(workflow).not.toContain('secrets/ci.yaml');
    expect(workflow).not.toContain('SOPS_AGE_KEY');
    expect(workflow).not.toContain('create-github-app-token');
    // No silent degradation path: there is one credential, so a green result
    // never means "verified with something weaker than intended".
    expect(settingsRun).not.toContain('::warning::');
    expect(workflow).not.toMatch(WRITE_PERMISSION_INPUT);
  });

  it('grants label reads only to the check aggregator job', () => {
    const parsedWorkflow = parseYaml(
      readFileSync(STANDARDS_WORKFLOW, 'utf8'),
    ) as { readonly permissions?: unknown };
    const jobs = yamlJobs(STANDARDS_WORKFLOW);

    expect(parsedWorkflow.permissions).toEqual({ contents: 'read' });
    expect(jobs.quality.permissions).toBeUndefined();
    expect(jobs.check.permissions).toEqual({
      contents: 'read',
      issues: 'read',
    });
    expect(jobs['github-settings']).toBeUndefined();
  });

  it('pins and verifies architecture-specific actionlint release assets', () => {
    const lintStep = yamlStep(STANDARDS_WORKFLOW, 'Lint workflows');
    expect(lintStep).toContain('version=1.7.12');
    expect(lintStep.match(/sha=[a-f0-9]{64}/gu)).toHaveLength(2);
    expect(lintStep).toMatch(ACTIONLINT_ASSET_PATTERN);
    expect(lintStep).toContain('sha256sum --check --quiet');
    expect(lintStep).not.toContain('download-actionlint.bash');
    expect(lintStep).not.toContain(' latest ');
  });

  it('installs a version-pinned just for the canonical justfile gate tests', () => {
    const workflow = readFileSync(STANDARDS_WORKFLOW, 'utf8');
    expect(workflow).toContain('uses: extractions/setup-just@v4');
    expect(workflow).toContain('just-version: "1.57.0"');
  });
});

it('allows only trusted-publication caches in the approved contract', () => {
  expect(() =>
    assertQualityCacheContract(parseWorkflow(STANDARDS_WORKFLOW)),
  ).not.toThrow();
});

it('accepts semantically identical cache mappings in any key order', () => {
  const workflow = structuredClone(parseWorkflow(STANDARDS_WORKFLOW));
  qualityStep(workflow, 'Restore the Turbo cache').with = {
    key: TURBO_CACHE_KEY,
    path: '.turbo/cache',
    'restore-keys': `${TURBO_CACHE_RESTORE_PREFIX}\n`,
  };
  expect(() => assertQualityCacheContract(workflow)).not.toThrow();
});

it('rejects stale and untrusted cache action mutations', () => {
  const rejected = rejectedQualityCacheMutations([
    (workflow) => {
      qualityStep(workflow, 'Restore the Turbo cache').with = {
        path: '.turbo/other-cache',
        key: TURBO_CACHE_KEY,
        'restore-keys': `${TURBO_CACHE_RESTORE_PREFIX}\n`,
      };
    },
    (workflow) => {
      qualityStep(workflow, 'Restore the Turbo cache').with = {
        path: '.turbo/cache',
        key: `turbo-${githubExpression('runner.os')}-${githubExpression('runner.arch')}`,
        'restore-keys': `${TURBO_CACHE_RESTORE_PREFIX}\n`,
      };
    },
    (workflow) => {
      qualityStep(workflow, 'Save the Turbo cache').with = {
        path: '.turbo/cache',
        key: `turbo-${githubExpression('runner.os')}-${githubExpression('runner.arch')}`,
      };
    },
    (workflow) => {
      qualityStep(workflow, 'Restore the Turbo cache').with = {
        path: '.turbo/cache',
        key: TURBO_CACHE_KEY,
        'restore-keys': `turbo-${githubExpression('runner.os')}-`,
      };
    },
    (workflow) => {
      qualityStep(workflow, 'Save the Turbo cache').if = 'success()';
    },
    (workflow) => {
      qualityStep(workflow, 'Restore the Turbo cache').uses =
        'actions/cache@v4';
    },
    (workflow) => {
      qualityStep(workflow, 'Restore the Turbo cache').unexpected = true;
    },
    (workflow) => {
      moveQualityStepBefore(workflow, 'Check', 'Restore the Turbo cache');
    },
    (workflow) => {
      const qualityJob = workflow.jobs.quality;
      if (!Array.isArray(qualityJob.steps)) {
        throw new Error('Quality job must contain a steps array');
      }
      qualityJob.steps.push({
        name: 'Restore an executable cache',
        uses: 'actions/cache@v4',
        with: { path: '~/.cache/ms-playwright', key: 'unapproved' },
      });
    },
  ]);
  expect(rejected).toEqual(rejected.map(() => true));
});

it('rejects softened executable-cache boundaries and consumers', () => {
  const rejected = rejectedQualityCacheMutations([
    (workflow) => {
      qualityEnvironment(workflow).BUN_INSTALL_CACHE_DIR =
        '~/.bun/install/cache';
    },
    (workflow) => {
      qualityEnvironment(workflow).PLAYWRIGHT_BROWSERS_PATH =
        '~/.cache/ms-playwright';
    },
    (workflow) => {
      qualityStep(workflow, 'Install dependencies').run = 'bun install';
    },
    (workflow) => {
      qualityStep(workflow, 'Install dependencies')['continue-on-error'] = true;
    },
    (workflow) => {
      qualityStep(workflow, 'Install Playwright Chromium').run = 'echo skipped';
    },
    (workflow) => {
      qualityStep(workflow, 'Install Playwright Chromium').if = 'always()';
    },
    (workflow) => {
      qualityStep(workflow, 'Install Playwright Chromium')[
        'continue-on-error'
      ] = true;
    },
    (workflow) => {
      qualityStep(workflow, 'Check').run = 'bun run lint';
    },
    (workflow) => {
      qualityStep(workflow, 'Check')['continue-on-error'] = true;
    },
    (workflow) => {
      qualityStep(workflow, 'Check').if = 'always()';
    },
    (workflow) => {
      qualityStep(workflow, 'Check').if = "github.event_name == 'pull_request'";
    },
    (workflow) => {
      qualityStep(workflow, 'Prune the Turbo cache before save')[
        'continue-on-error'
      ] = true;
    },
    (workflow) => {
      qualityStep(workflow, 'Prune the Turbo cache before save').if =
        'success()';
    },
    (workflow) => {
      const pruneStep = qualityStep(
        workflow,
        'Prune the Turbo cache before save',
      );
      pruneStep.run = String(pruneStep.run).replace(
        'set -euo pipefail',
        'set +e',
      );
    },
    (workflow) => {
      moveQualityStepBefore(workflow, 'Save the Bun package cache', 'Check');
    },
    (workflow) => {
      moveQualityStepBefore(
        workflow,
        'Save the Playwright browser cache',
        'Check',
      );
    },
    (workflow) => {
      moveQualityStepBefore(
        workflow,
        'Prune the Turbo cache before save',
        'Check',
      );
    },
    (workflow) => {
      moveQualityStepBefore(
        workflow,
        'Save the Turbo cache',
        'Prune the Turbo cache before save',
      );
    },
  ]);
  expect(rejected).toEqual(rejected.map(() => true));
});

describe('canonical standards workflow Turbo cache pruning', () => {
  it('keeps the newest Turbo artifacts within the declared save budget', () => {
    const pruneScript = yamlRunScript(
      STANDARDS_WORKFLOW,
      'Prune the Turbo cache before save',
    );
    expect(pruneScript).toContain('budget=$((2 * 1024 * 1024))');

    const absentFixture = mkTmp('turbo-prune-absent-');
    expect(
      runExecutable('bash', absentFixture, ['-c', pruneScript]).status,
    ).toBe(0);

    const failingFindFixture = mkTmp('turbo-prune-failing-find-');
    write(failingFindFixture, '.turbo/cache/artifact', 'cached');
    const failingFindScript = `find() { return 42; }\n${pruneScript}`;
    expect(
      runExecutable('bash', failingFindFixture, ['-c', failingFindScript])
        .status,
    ).not.toBe(0);

    const fixture = mkTmp('turbo-prune-');
    const cachePath = '.turbo/cache';
    const files = [
      ['oldest', OLDEST_CACHE_MTIME],
      ['middle', MIDDLE_CACHE_MTIME],
      ['newest', NEWEST_CACHE_MTIME],
    ] as const;
    for (const [name, mtime] of files) {
      write(
        fixture,
        `${cachePath}/${name}`,
        'x'.repeat(CACHE_FIXTURE_FILE_SIZE),
      );
      utimesSync(join(fixture, cachePath, name), mtime, mtime);
    }

    const fixtureScript = pruneScript.replace(
      'budget=$((2 * 1024 * 1024))',
      'budget=8',
    );
    expect(runExecutable('bash', fixture, ['-c', fixtureScript]).status).toBe(
      0,
    );
    expect(readdirSync(join(fixture, cachePath)).sort()).toEqual([
      'middle',
      'newest',
    ]);

    const invertedScript = fixtureScript.replace(
      'if (total > budget)',
      'if (total < budget)',
    );
    const invertedFixture = mkTmp('turbo-prune-inverted-');
    for (const [name, mtime] of files) {
      write(
        invertedFixture,
        `${cachePath}/${name}`,
        'x'.repeat(CACHE_FIXTURE_FILE_SIZE),
      );
      utimesSync(join(invertedFixture, cachePath, name), mtime, mtime);
    }
    expect(
      runExecutable('bash', invertedFixture, ['-c', invertedScript]).status,
    ).toBe(0);
    expect(readdirSync(join(invertedFixture, cachePath)).sort()).not.toEqual([
      'middle',
      'newest',
    ]);
  });
});

describe('canonical standards workflow Nix gate', () => {
  it('derives every native Nix job from validated metadata at the tested commit', () => {
    const jobs = yamlJobs(STANDARDS_WORKFLOW);
    const discoveryJob = jobs['nix-discovery'];
    const nixJob = jobs.nix;
    const checkSteps = jobs.check.steps as ReadonlyArray<
      Readonly<Record<string, unknown>>
    >;
    const aggregateStep = checkSteps.find(
      (step) => step.name === 'Require all standards gates',
    );

    expect(discoveryJob.if).toBe(SOURCE_REPOSITORY_CONDITION);
    expect(nixJob.if).toBe(SOURCE_REPOSITORY_CONDITION);
    expect(aggregateStep?.env).toEqual(
      expect.objectContaining({
        IS_SOURCE_REPOSITORY: githubExpression(SOURCE_REPOSITORY_CONDITION),
      }),
    );
    expect(discoveryJob['runs-on']).toBe('ubuntu-latest');
    expect(discoveryJob.outputs).toEqual({
      matrix: githubExpression('steps.matrix.outputs.matrix'),
    });
    expect(nixJob['runs-on']).toBe(githubMatrixExpression('runner'));
    expect(nixJob.needs).toBe('nix-discovery');
    expect(nixJob.strategy).toEqual({
      'fail-fast': false,
      matrix: githubExpression('fromJSON(needs.nix-discovery.outputs.matrix)'),
    });
    for (const job of [discoveryJob, nixJob]) {
      expect(job.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'Checkout',
            with: { ref: githubExpression('github.sha') },
          }),
        ]),
      );
    }
    expect(nixJob.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Install Nix',
          uses: 'cachix/install-nix-action@v31',
        }),
        expect.objectContaining({
          name: 'Test Nix system metadata',
          run: 'bash nix/bun-system-metadata.test.sh',
        }),
        expect.objectContaining({
          name: 'Build Nix check',
          run: `nix build ".#checks.${githubMatrixExpression('system')}.standards-cli" -L`,
        }),
      ]),
    );
  });

  it('emits the current native runner matrix from its sole JSON owner', () => {
    const { output, result } = runNixDiscovery({
      filter: readFileSync(NIX_SYSTEM_MATRIX_FILTER, 'utf8'),
      metadata: readFileSync(NIX_SYSTEM_METADATA, 'utf8'),
    });

    expect(result.status).toBe(0);
    expect(output).toBe(
      'matrix={"include":[{"runner":"ubuntu-24.04-arm","system":"aarch64-linux"},{"runner":"ubuntu-24.04","system":"x86_64-linux"}]}\n',
    );
  });

  it('fails discovery when the Punktlandung matrix filter is missing', () => {
    const { output, result } = runNixDiscovery({
      filter: undefined,
      metadata: readFileSync(NIX_SYSTEM_METADATA, 'utf8'),
    });

    expect(result.status).not.toBe(0);
    expect(output).toBe('');
    expect(result.stderr).toContain('nix/bun-system-matrix.jq');
  });

  it.each([
    ['missing metadata', undefined],
    ['invalid JSON', 'not json'],
    ['an empty system set', '{}'],
    [
      'a missing runner mapping',
      '{"x86_64-linux":{"archiveHash":"sha256-lR7iruhV8IWVruxiJSJqKY0/6oOj3NZGXAnLzN9+hI8=","archivePlatform":"x64"}}',
    ],
    [
      'a non-GitHub runner mapping',
      '{"x86_64-linux":{"archiveHash":"sha256-lR7iruhV8IWVruxiJSJqKY0/6oOj3NZGXAnLzN9+hI8=","archivePlatform":"x64","runner":"self-hosted"}}',
    ],
  ])('fails discovery for %s', (_label, metadata) => {
    const { output, result } = runNixDiscovery({
      filter: readFileSync(NIX_SYSTEM_MATRIX_FILTER, 'utf8'),
      metadata,
    });

    expect(result.status).not.toBe(0);
    expect(output).toBe('');
  });
});

describe('canonical standards workflow Nix aggregation', () => {
  const needsResults = ['success', 'failure', 'cancelled', 'skipped'] as const;
  const runAggregate = (
    aggregateScript: string,
    results: Readonly<Record<string, string>>,
  ): number =>
    runExecutable(
      'bash',
      ACTUAL_UPSTREAM,
      ['-euo', 'pipefail', '-c', aggregateScript],
      results,
    ).status;

  it('requires the exact repository-mode result across every Nix needs outcome', () => {
    const jobs = yamlJobs(STANDARDS_WORKFLOW);
    const aggregateScript = yamlRunScript(
      STANDARDS_WORKFLOW,
      'Require all standards gates',
    );

    expect(jobs.check.if).toBe('always()');
    expect(jobs.check.needs).toEqual(['quality', 'nix-discovery', 'nix']);

    for (const [isSourceRepository, expectedNixResult] of [
      ['true', 'success'],
      ['false', 'skipped'],
    ] as const) {
      for (const nixDiscoveryResult of needsResults) {
        for (const nixResult of needsResults) {
          const status = runAggregate(aggregateScript, {
            IS_SOURCE_REPOSITORY: isSourceRepository,
            NIX_DISCOVERY_RESULT: nixDiscoveryResult,
            NIX_RESULT: nixResult,
            QUALITY_RESULT: 'success',
          });
          const expectedStatus =
            nixDiscoveryResult === expectedNixResult &&
            nixResult === expectedNixResult
              ? 0
              : 1;

          expect(status).toBe(expectedStatus);
        }
      }
    }
  });

  it('rejects mixed-case and otherwise unexpected repository modes', () => {
    const aggregateScript = yamlRunScript(
      STANDARDS_WORKFLOW,
      'Require all standards gates',
    );

    for (const isSourceRepository of ['True', 'FALSE', 'unexpected']) {
      for (const nixDiscoveryResult of needsResults) {
        for (const nixResult of needsResults) {
          expect(
            runAggregate(aggregateScript, {
              IS_SOURCE_REPOSITORY: isSourceRepository,
              NIX_DISCOVERY_RESULT: nixDiscoveryResult,
              NIX_RESULT: nixResult,
              QUALITY_RESULT: 'success',
            }),
          ).not.toBe(0);
        }
      }
    }
  });

  it('requires the quality gate in source and consumer modes', () => {
    const aggregateScript = yamlRunScript(
      STANDARDS_WORKFLOW,
      'Require all standards gates',
    );

    for (const [isSourceRepository, nixResult] of [
      ['true', 'success'],
      ['false', 'skipped'],
    ] as const) {
      for (const qualityResult of needsResults) {
        const status = runAggregate(aggregateScript, {
          IS_SOURCE_REPOSITORY: isSourceRepository,
          NIX_DISCOVERY_RESULT: nixResult,
          NIX_RESULT: nixResult,
          QUALITY_RESULT: qualityResult,
        });

        expect(status).toBe(qualityResult === 'success' ? 0 : 1);
      }
    }
  });
});

describe('canonical workflow runner boundaries', () => {
  it('reserves the configurable runner for Standards quality only', () => {
    const {
      configurableRunnerOccurrences,
      fixedRunnerJobDefinitions,
      fixedRunnerJobs,
      qualityRunner,
      workflowPaths,
    } = inspectCanonicalWorkflowRunnerBoundaries(ACTUAL_UPSTREAM);
    expect(workflowPaths.toSorted()).toEqual([
      '.github/workflows/notify-pause.yml',
      '.github/workflows/standards-sync.yml',
      '.github/workflows/standards.yml',
    ]);

    expect(qualityRunner).toContain('vars.CI_RUNNER');
    expect(qualityRunner).toContain('ubuntu-latest');
    expect(fixedRunnerJobs).toEqual({
      '.github/workflows/notify-pause.yml:notify': 'ubuntu-latest',
      '.github/workflows/standards-sync.yml:policy': 'ubuntu-latest',
      '.github/workflows/standards-sync.yml:sync': 'ubuntu-latest',
      '.github/workflows/standards.yml:check': 'ubuntu-latest',
      '.github/workflows/standards.yml:nix-discovery': 'ubuntu-latest',
      '.github/workflows/standards.yml:nix': githubMatrixExpression('runner'),
    });
    expect(() =>
      assertFixedRunnerJobsDoNotUseConfigurableRunner(
        fixedRunnerJobDefinitions,
      ),
    ).not.toThrow();
    expect(configurableRunnerOccurrences).toBe(1);
  });

  it('rejects configurable runners in manifest-owned .yaml workflows', () => {
    const fixture = mkTmp('canonical-yaml-runner-boundary-');
    write(
      fixture,
      'sync-standards.json',
      JSON.stringify({
        paths: ['.github/workflows/additional-check.yaml'],
        seedDir: 'template',
        upstream: 'github:davidvornholt/standards',
      }),
    );
    // Two violating jobs, so one run must name both: a first-match report would
    // cost a maintainer one fix-and-rerun cycle per offending job.
    write(
      fixture,
      '.github/workflows/additional-check.yaml',
      [
        'on:',
        '  push:',
        'jobs:',
        '  additional-check:',
        `    runs-on: ${githubExpression("vars.CI_RUNNER || 'ubuntu-latest'")}`,
        '    steps:',
        '      - run: echo additional-check',
        '  additional-verify:',
        `    runs-on: ${githubExpression("vars.CI_RUNNER || 'ubuntu-latest'")}`,
        '    steps:',
        '      - run: echo additional-verify',
        '',
      ].join('\n'),
    );

    const inspection = inspectCanonicalWorkflowRunnerBoundaries(fixture);

    expect(inspection.workflowPaths).toEqual([
      '.github/workflows/additional-check.yaml',
    ]);
    expect(() =>
      assertFixedRunnerJobsDoNotUseConfigurableRunner(
        inspection.fixedRunnerJobDefinitions,
      ),
    ).toThrow(
      'Jobs must use a fixed runner, but these select vars.CI_RUNNER: .github/workflows/additional-check.yaml:additional-check, .github/workflows/additional-check.yaml:additional-verify. Only .github/workflows/standards.yml:quality may select vars.CI_RUNNER.',
    );
  });
});

describe('canonical SOPS secret action wiring', () => {
  it('serves workflows that can safely execute the checked-out local action', () => {
    const action = readFileSync(SOPS_ACTION, 'utf8');
    const canonicalActionPath = '.github/actions/sops-secret/action.yml';
    const productionFiles = readProductionGithubFiles();
    const sopsInstallers = productionFiles
      .filter(({ content }) => content.match(SOPS_RELEASE_URL) !== null)
      .map(({ path }) => path);
    // The settings gate is deliberately absent: it resolves no SOPS secret, so
    // it must not check out or execute the resolver either.
    const localActionWorkflows = [
      readFileSync(SYNC_WORKFLOW, 'utf8'),
      readFileSync(NOTIFY_WORKFLOW, 'utf8'),
    ];
    expect(action.match(SOPS_VERSION_ASSIGNMENT)).toHaveLength(1);
    expect(action.match(SOPS_CHECKSUM_ASSIGNMENT)).toHaveLength(2);
    // The action is the only owner of the SOPS pin. A workflow that installs
    // SOPS itself is a second copy of this file's release URL and checksums,
    // which is exactly the drift the resolver exists to prevent.
    expect(sopsInstallers).toEqual([canonicalActionPath]);
    for (const workflow of localActionWorkflows) {
      expect(workflow).toContain('uses: ./.github/actions/sops-secret');
    }
    const syncManifest = JSON.parse(
      readFileSync(join(ACTUAL_UPSTREAM, 'sync-standards.json'), 'utf8'),
    ) as { readonly paths: ReadonlyArray<string> };
    expect(syncManifest.paths).toContain('.github/actions/sops-secret');
  });
});

describe('standards sync workflow ordering', () => {
  it('detects a clean mirror without opening a pull request', () => {
    const fixture = mkTmp('sync-clean-');
    const outputPath = join(mkTmp('sync-output-'), 'github-output');
    expect(runExecutable('git', fixture, ['init', '--quiet']).status).toBe(0);

    const result = runExecutable(
      'bash',
      fixture,
      ['-euo', 'pipefail', '-c', workflowRunScript('Detect mirror changes')],
      { GITHUB_OUTPUT: outputPath },
    );

    expect(result.status).toBe(0);
    expect(readFileSync(outputPath, 'utf8')).toBe('changed=false\n');
    expect(result.stdout).toContain('Already in sync');
  });

  it('resolves broker credentials through the trusted action before sync and never executes post-sync action content', () => {
    const jobs = yamlJobs(SYNC_WORKFLOW);
    const { steps } = jobs.sync;
    if (!Array.isArray(steps)) {
      throw new Error('Standards sync job must contain steps');
    }
    const stepNames = steps.map((step) =>
      typeof step === 'object' && step !== null && 'name' in step
        ? step.name
        : null,
    );
    const resolveAppIdIndex = stepNames.indexOf('Resolve broker App ID');
    const resolvePrivateKeyIndex = stepNames.indexOf(
      'Resolve broker App private key',
    );
    const mintIndex = stepNames.indexOf('Mint current-repository PR token');
    const clearIndex = stepNames.indexOf('Clear broker App credentials');
    const syncIndex = stepNames.indexOf('Sync canonical files from upstream');
    const localActionIndexes = steps.flatMap((step, index) =>
      typeof step === 'object' &&
      step !== null &&
      'uses' in step &&
      step.uses === './.github/actions/sops-secret'
        ? [index]
        : [],
    );
    expect(resolveAppIdIndex).toBeGreaterThan(-1);
    expect(resolvePrivateKeyIndex).toBeGreaterThan(resolveAppIdIndex);
    expect(mintIndex).toBeGreaterThan(resolvePrivateKeyIndex);
    expect(clearIndex).toBeGreaterThan(mintIndex);
    expect(syncIndex).toBeGreaterThan(clearIndex);
    expect(localActionIndexes).toEqual([
      resolveAppIdIndex,
      resolvePrivateKeyIndex,
    ]);
    expect(localActionIndexes.every((index) => index < syncIndex)).toBe(true);
  });

  it('orders generated migration guidance before merge', () => {
    const openPullRequest = workflowRunScript(
      'Open a pull request if the mirror changed',
    );
    const applyIndex = openPullRequest.indexOf('bun standards github --apply');
    const mergeIndex = openPullRequest.indexOf(
      'Merge only after every required check passes',
    );

    expect(openPullRequest).toContain('allow_merge_commit');
    expect(openPullRequest).toContain('allow_rebase_merge');
    expect(openPullRequest).toContain('allow_squash_merge');
    expect(applyIndex).toBeGreaterThan(-1);
    expect(mergeIndex).toBeGreaterThan(applyIndex);
  });
});

describe('standards sync workflow policy', () => {
  const runPolicyPreflight = (
    policy: string | undefined,
    legacy: Readonly<Record<string, string>> = {},
  ): { result: RunResult; output: string } => {
    const fixture = mkTmp('sync-policy-');
    if (policy !== undefined) {
      write(fixture, 'sync-standards.local.json', policy);
    }
    const outputPath = join(fixture, 'github-output');
    const result = runExecutable(
      'bash',
      fixture,
      ['-euo', 'pipefail', '-c', workflowRunScript('Read sync policy')],
      { GITHUB_OUTPUT: outputPath, ...legacy },
    );
    return {
      result,
      output: existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '',
    };
  };

  it('uses defaults when the policy is absent and ignores legacy variables', () => {
    const { result, output } = runPolicyPreflight(undefined, {
      STANDARDS_AUTO_SYNC: 'false',
      STANDARDS_SYNC_REF: 'v0.6.0',
    });

    expect(result.status).toBe(0);
    expect(output).toContain('auto-sync=true');
    expect(output).toContain('present=false');
    expect(output).toContain('ref=\n');
    expect(readFileSync(SYNC_WORKFLOW, 'utf8')).not.toContain(
      'STANDARDS_AUTO_SYNC',
    );
    expect(readFileSync(SYNC_WORKFLOW, 'utf8')).not.toContain(
      'STANDARDS_SYNC_REF',
    );
  });

  it('emits a validated scheduled-run opt-out and pin', () => {
    const { result, output } = runPolicyPreflight(
      '{ "autoSync": false, "ref": "v0.7.0" }\n',
    );

    expect(result.status).toBe(0);
    expect(output).toContain('auto-sync=false');
    expect(output).toContain('present=true');
    expect(output).toContain('ref=v0.7.0');
  });

  it.each([
    ['malformed JSON', 'not json'],
    ['a null root', 'null'],
    ['an array root', '[]'],
    ['a wrong autoSync type', '{ "autoSync": "false" }'],
    ['a numeric autoSync', '{ "autoSync": 0 }'],
    ['a wrong ref type', '{ "ref": 1 }'],
    ['an empty ref', '{ "ref": "" }'],
    ['a newline in ref', '{ "ref": "main\\npresent=false" }'],
    ['a carriage return in ref', '{ "ref": "main\\rpresent=false" }'],
    ['an unsupported field', '{ "branch": "stable" }'],
  ])('fails closed for %s', (_label, policy) => {
    const { result, output } = runPolicyPreflight(policy);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'sync-standards.local.json must be an object',
    );
    expect(output).toBe('');
  });

  it.each([
    '0.9.0',
    '0.10.0',
    '0.10.1',
    '0.10.2',
    '0.10.0-beta.1',
    '0.11.0',
    '0.11.1',
    '0.12.0',
    '0.12.1',
    '0.13.0',
    '0.13.1',
    '0.14.0',
    '0.14.1',
    '0.15.1',
    '0.16.0',
    '0.17.3',
    '0.18.0',
    '0.18.1',
    '0.20.0',
  ])('rejects installed CLI version %s without a policy file', (version) => {
    const result = runWorkflowVersionGuard(version);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('::error::');
  });

  it('makes the 0.21.0 guard unconditional', () => {
    const workflow = readFileSync(SYNC_WORKFLOW, 'utf8');
    expect(workflow).toContain('MINIMUM_STANDARDS_VERSION: "0.21.0"');
    expect(workflow).not.toContain(
      "if: needs.policy.outputs.present == 'true'",
    );
  });

  it.each([
    '0.21.0',
    '0.21.1',
    '1.0.0',
  ])('accepts installed CLI version %s without a policy file', (version) => {
    expect(runWorkflowVersionGuard(version).status).toBe(0);
  });
});

describe('standards sync workflow trigger policy', () => {
  it('allows only the weekly schedule trigger', () => {
    expect(workflowTriggerNames(SYNC_WORKFLOW)).toEqual(['schedule']);
  });

  it.each([
    'push',
    'pull_request_target',
    'workflow_dispatch',
    'workflow_call',
  ])('detects unsafe alternative trigger %s', (trigger) => {
    const fixture = mkTmp('workflow-trigger-policy-');
    const path = join(fixture, 'standards-sync.yml');
    write(
      fixture,
      'standards-sync.yml',
      [
        'on:',
        '  schedule:',
        '    - cron: "0 6 * * 1"',
        `  ${trigger}:`,
        'jobs:',
        '  sync:',
        '    runs-on: ubuntu-latest',
        '',
      ].join('\n'),
    );

    expect(workflowTriggerNames(path)).toEqual(['schedule', trigger]);
    expect(workflowTriggerNames(path)).not.toEqual(['schedule']);
  });
});

describe('github', () => {
  const EmptySeam = JSON.stringify({ repository: {}, rulesets: [] });
  const Canonical = JSON.stringify({
    repository: { allow_auto_merge: true },
    rulesets: [{ name: 'Protect main', target: 'branch' }],
  });

  it('fails when the canonical declaration is missing', () => {
    const { consumer } = initConsumer(buildUpstream());
    const result = run(consumer, ['github', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('.github/settings.json not found');
  });

  it('fails closed when the origin remote cannot be resolved', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/settings.json', Canonical);
    write(consumer, '.github/settings.local.json', EmptySeam);
    const result = run(consumer, ['github', '--check', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'cannot determine the GitHub repository from the origin remote',
    );
  });

  it('apply also requires a resolvable origin remote', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/settings.json', Canonical);
    write(consumer, '.github/settings.local.json', EmptySeam);
    const result = run(consumer, ['github', '--apply', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'cannot determine the GitHub repository from the origin remote',
    );
  });

  it('check gates on the declaration once it is present', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/settings.json', Canonical);
    write(consumer, '.github/settings.local.json', EmptySeam);
    const result = run(consumer, ['check', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'cannot determine the GitHub repository from the origin remote',
    );
  });
});

describe('github workflow skip seam', () => {
  const EmptySeam = JSON.stringify({ repository: {}, rulesets: [] });
  const Canonical = JSON.stringify({
    repository: { allow_auto_merge: true },
    rulesets: [{ name: 'Protect main', target: 'branch' }],
  });

  it('skips the duplicated live check only for the canonical workflow value', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/settings.json', Canonical);
    write(consumer, '.github/settings.local.json', EmptySeam);
    const result = runExecutable(
      'bun',
      consumer,
      [ENGINE, 'check', '--dir', consumer],
      { STANDARDS_SKIP_GITHUB_CHECK: 'true' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'live settings check skipped because STANDARDS_SKIP_GITHUB_CHECK=true',
    );
  });

  it('applies the workflow skip seam to explicit github checks but not apply', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/settings.json', Canonical);
    write(consumer, '.github/settings.local.json', EmptySeam);
    const check = runExecutable(
      'bun',
      consumer,
      [ENGINE, 'github', '--check', '--dir', consumer],
      { STANDARDS_SKIP_GITHUB_CHECK: 'true' },
    );
    const apply = runExecutable(
      'bun',
      consumer,
      [ENGINE, 'github', '--apply', '--dir', consumer],
      { STANDARDS_SKIP_GITHUB_CHECK: 'true' },
    );
    expect(check.status).toBe(0);
    expect(check.stdout).toContain(
      'live settings check skipped because STANDARDS_SKIP_GITHUB_CHECK=true',
    );
    expect(apply.status).toBe(1);
    expect(apply.stderr).toContain(
      'cannot determine the GitHub repository from the origin remote',
    );
  });
});

describe('github configuration validation', () => {
  const EmptySeam = JSON.stringify({ repository: {}, rulesets: [] });
  const Canonical = JSON.stringify({
    repository: { allow_auto_merge: true },
    rulesets: [{ name: 'Protect main', target: 'branch' }],
  });

  it('does not skip for a truthy-looking value other than exact true', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/settings.json', Canonical);
    write(consumer, '.github/settings.local.json', EmptySeam);
    const result = runExecutable(
      'bun',
      consumer,
      [ENGINE, 'github', '--check', '--dir', consumer],
      { STANDARDS_SKIP_GITHUB_CHECK: 'TRUE' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'cannot determine the GitHub repository from the origin remote',
    );
  });

  it('doctor requires the local seam once the declaration is synced', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/settings.json', Canonical);
    const result = run(consumer, ['doctor', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('.github/settings.local.json must exist');
  });

  it('doctor rejects a seam that overrides canonical values', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/settings.json', Canonical);
    write(
      consumer,
      '.github/settings.local.json',
      JSON.stringify({
        repository: { allow_auto_merge: false },
        rulesets: [{ name: 'Protect main' }],
      }),
    );
    const result = run(consumer, ['doctor', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'repository."allow_auto_merge" would override a canonical value',
    );
    expect(result.stderr).toContain(
      'ruleset "Protect main" collides with a canonical ruleset',
    );
  });

  it('rejects --apply outside the github command and combined with --check', () => {
    const consumer = mkTmp('sync-cons-');
    const outside = run(consumer, ['sync', '--apply', '--dir', consumer]);
    expect(outside.status).toBe(1);
    expect(outside.stderr).toContain(
      '--apply is only valid with the github command',
    );
    const combined = run(consumer, [
      'github',
      '--check',
      '--apply',
      '--dir',
      consumer,
    ]);
    expect(combined.status).toBe(1);
    expect(combined.stderr).toContain(
      'github accepts exactly one of --check or --apply',
    );
  });
});

describe('option validation', () => {
  it('rejects --check outside the github and dependabot commands', () => {
    const consumer = mkTmp('sync-cons-');
    const result = run(consumer, ['sync', '--check', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '--check is only valid with the github and dependabot commands',
    );
  });

  it('rejects --write outside the dependabot command', () => {
    const consumer = mkTmp('sync-cons-');
    const result = run(consumer, ['sync', '--write', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '--write is only valid with the dependabot command',
    );
  });
});

describe('help', () => {
  it('fails with usage when no command is given', () => {
    const consumer = mkTmp('sync-cons-');
    const result = run(consumer, ['--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('a command is required');
    expect(result.stderr).toContain('Usage: standards <command>');
  });

  it('prints usage and exits 0 for help, --help, and -h', () => {
    const consumer = mkTmp('sync-cons-');
    for (const spelling of ['help', '--help', '-h']) {
      const result = run(consumer, [spelling]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Usage: standards <command>');
      expect(result.stdout).toContain('remote Git/GitHub sources only');
    }
  });
});

describe('unknown command', () => {
  it('exits 1 with Unknown command', () => {
    const consumer = mkTmp('sync-cons-');
    const result = run(consumer, ['bogus', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown command');
  });
});

describe('path safety', () => {
  it('rejects managed paths that escape the source repository', () => {
    const up = buildUpstream(['../outside']);
    const consumer = mkTmp('sync-cons-');
    const result = run(consumer, ['init', '--from', up, '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'managed path must be a normalized repository-relative path',
    );
  });
});

describe('poller', () => {
  it('requires --config', () => {
    const consumer = mkTmp('poller-');
    const result = run(consumer, ['poller']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--config <path> is required');
  });

  it('rejects poller flags on other commands', () => {
    const consumer = mkTmp('poller-');
    const result = run(consumer, ['check', '--config', 'x.json']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '--config is only valid with the poller command',
    );
  });

  it('rejects the removed imperative --install option', () => {
    const consumer = mkTmp('poller-');
    const result = run(consumer, ['poller', '--install', '--config', 'x.json']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown option: --install');
  });

  it('fails loudly on an invalid config file', () => {
    const consumer = mkTmp('poller-');
    writeFileSync(
      join(consumer, 'poller.json'),
      '{"repos":[],"model":"gpt-5.6-sol","reasoningEffort":"high"}',
    );
    const result = run(consumer, [
      'poller',
      '--config',
      join(consumer, 'poller.json'),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'poller config "repos" must list at least one repository',
    );
  });

  it('prints systemd units sized from the config without touching the host', () => {
    const consumer = mkTmp('poller-');
    const configPath = join(consumer, 'poller.json');
    writeFileSync(
      configPath,
      '{"repos":["owner/repo"],"model":"gpt-5.6-sol","reasoningEffort":"high"}',
    );
    const result = run(consumer, [
      'poller',
      '--print-units',
      '--config',
      configPath,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('standards-poller.service');
    expect(result.stdout).toContain(
      'standards-poller-acknowledgements.service',
    );
    expect(result.stdout).toContain(`poller --config "${configPath}"`);
    expect(result.stdout).toContain(
      `poller --acknowledge-only --config "${configPath}"`,
    );
    expect(result.stdout).toContain('TimeoutStartSec=270min');
  });
});

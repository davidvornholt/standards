import { expect, it } from 'bun:test';
import process from 'node:process';
import { ACTUAL_UPSTREAM, runProcess } from './cli-test-support';
import {
  contract,
  DIGEST_A,
  environment,
  SHA_A,
  yamlContract,
} from './image-promotion-reference-contract-test-support';

const DISPATCH_COMMAND = /gh api[\s\S]*$/u;
type Mapping = Readonly<Record<string, string>>;
type Step = {
  readonly id?: string;
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Mapping;
};
type Job = {
  readonly needs?: string;
  readonly outputs?: Mapping;
  readonly permissions?: Mapping;
  readonly steps: ReadonlyArray<Step>;
};
type Workflow = {
  readonly jobs: Readonly<Record<string, Job>>;
  readonly permissions: Mapping;
};

const jobNamed = (workflow: Workflow, name: string): Job => {
  const job = workflow.jobs[name];
  if (job === undefined) {
    throw new Error(`missing workflow job ${name}`);
  }
  return job;
};

const promotionEnvironment = environment([
  ['DIGEST', DIGEST_A],
  ['IMAGE_REPOSITORY', 'ghcr.io/example/app/web'],
  ['PATH', process.env.PATH],
  ['SOURCE_REF', 'refs/heads/main'],
  ['SOURCE_REPOSITORY', 'example/app'],
  ['SOURCE_RUN_ID', '42'],
  ['SOURCE_SHA', SHA_A],
]);

it('emits one machine-readable record from the successful build', () => {
  const source = yamlContract<Workflow>('source-workflow');
  const build = jobNamed(source, 'build');
  const emit = build.steps.find(
    (step) => step.name === 'Emit immutable promotion record',
  );
  expect(source.permissions).toEqual({ contents: 'read' });
  expect(build.permissions).toEqual({ contents: 'read', packages: 'write' });
  expect(emit?.run).toBeString();
  const result = runProcess(
    'bash',
    ACTUAL_UPSTREAM,
    ['-c', emit?.run ?? 'exit 2'],
    environment([
      ['DIGEST', DIGEST_A],
      ['IMAGE', 'ghcr.io/example/app/web'],
      ['PATH', process.env.PATH],
      ['REF', 'refs/heads/main'],
      ['REPOSITORY', 'example/app'],
      ['RUN_ID', '42'],
      ['SHA', SHA_A],
    ]),
  );
  expect(result).toMatchObject({ status: 0 });
  const record = result.stdout.replace('IMAGE_PROMOTION_RECORD ', '');
  expect(JSON.parse(record)).toEqual({
    digest: DIGEST_A,
    image: 'ghcr.io/example/app/web',
    ref: 'refs/heads/main',
    repository: 'example/app',
    runId: '42',
    sha: SHA_A,
  });
});

it('uses disjoint least-privilege source and writer tokens', () => {
  const source = yamlContract<Workflow>('source-workflow');
  const announce = jobNamed(source, 'announce');
  const broker = announce.steps.find((step) => step.id === 'broker');
  expect(announce.permissions).toEqual({ contents: 'read' });
  expect(broker?.with).toMatchObject({
    'permission-contents': 'write',
    repositories: 'infra',
  });
  expect(
    Object.keys(broker?.with ?? {}).filter((key) =>
      key.startsWith('permission-'),
    ),
  ).toEqual(['permission-contents']);
  expect(yamlContract<Step>('source-token').with).toEqual({
    owner: 'example',
    'permission-actions': 'read',
    repositories: 'app',
  });
  const images = JSON.parse(contract('images-json', 'json')) as {
    readonly web: {
      readonly sourceWorkflow: { readonly id: number; readonly path: string };
    };
  };
  expect(images.web.sourceWorkflow).toEqual({
    id: 123_456,
    path: '.github/workflows/build.yml',
  });
});

it('validates the announcement identity before dispatch', () => {
  const announce = jobNamed(
    yamlContract<Workflow>('source-workflow'),
    'announce',
  );
  const dispatch = announce.steps.find(
    (step) => step.name === 'Announce image digest',
  );
  const script = dispatch?.run?.replace(DISPATCH_COMMAND, 'printf dispatched');
  expect(
    runProcess(
      'bash',
      ACTUAL_UPSTREAM,
      ['-c', script ?? 'exit 2'],
      environment([
        ['BUILD_DIGEST', DIGEST_A],
        ...Object.entries(promotionEnvironment),
      ]),
    ),
  ).toMatchObject({ status: 0, stdout: 'dispatched' });
  for (const [key, value] of [
    ['BUILD_DIGEST', 'sha256:abc'],
    ['SOURCE_REPOSITORY', 'other/repo'],
    ['SOURCE_RUN_ID', '0'],
  ]) {
    const invalidEnvironment = environment([
      ['BUILD_DIGEST', DIGEST_A],
      ...Object.entries(promotionEnvironment),
      [key, value],
    ]);
    expect(
      runProcess(
        'bash',
        ACTUAL_UPSTREAM,
        ['-c', script ?? 'exit 2'],
        invalidEnvironment,
      ).status,
      key,
    ).not.toBe(0);
  }
});

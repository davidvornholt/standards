import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { parse } from 'yaml';
import { ACTUAL_UPSTREAM, runProcess } from './cli-test-support';

const DIGEST_LENGTH = 64;
const SHA_LENGTH = 40;
const TABLE_COLUMN_END = 3;
const DISPATCH_COMMAND = /gh api[\s\S]*$/u;
const FULL_IMAGE = /^ghcr\.io\/[^@]+@sha256:[0-9a-f]{64}$/u;
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const REFERENCE = join(
  ACTUAL_UPSTREAM,
  '.agents/skills/declarative-infra/references/image-promotion.md',
);
const document = readFileSync(REFERENCE, 'utf8');
type Mapping = Readonly<Record<string, string>>;
type Step = {
  readonly id?: string;
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Mapping;
};
type Job = {
  readonly if?: string;
  readonly needs?: string;
  readonly outputs?: Mapping;
  readonly permissions?: Mapping;
  readonly steps: ReadonlyArray<Step>;
};
type Workflow = {
  readonly concurrency?: Readonly<Record<string, string | boolean>>;
  readonly jobs: Readonly<Record<string, Job>>;
  readonly permissions?: Mapping;
};
const contract = (name: string, language: string): string => {
  const fence = '```';
  const pattern =
    `<!-- contract:${name} -->\\n${fence}${language}\\n` +
    `([\\s\\S]*?)\\n${fence}`;
  const content = document.match(new RegExp(pattern, 'u'))?.[1];
  if (content === undefined) {
    throw new Error(`missing ${name} contract`);
  }
  return content;
};
const yamlContract = <T>(name: string): T => parse(contract(name, 'yaml')) as T;
const jobNamed = (workflow: Workflow, name: string): Job => {
  const job = workflow.jobs[name];
  if (job === undefined) {
    throw new Error(`missing workflow job ${name}`);
  }
  return job;
};
it('keeps one complete per-app state owner and real source wiring', () => {
  const images = JSON.parse(contract('images-json', 'json')) as Record<
    string,
    Record<string, string | number>
  >;
  const { web } = images;
  expect(Object.keys(web).sort().join(',')).toBe(
    'digest,imageRepository,promotedSourceSha,promotionLatencyMinutes,sourceRef,sourceRepository,trackedTag',
  );
  expect(web.promotionLatencyMinutes).toBeGreaterThan(0);
  expect(web.sourceRepository).toBe('example/app');
  expect(web.sourceRef).toBe('refs/heads/main');
  expect(web.trackedTag).toBe('main');
  expect(`${web.imageRepository}@${web.digest}`).toMatch(FULL_IMAGE);
  expect(web.promotedSourceSha).toMatch(SOURCE_SHA);
  const source = yamlContract<Workflow>('source-workflow');
  const build = jobNamed(source, 'build');
  const announce = jobNamed(source, 'announce');
  expect(source.permissions).toEqual({ contents: 'read' });
  expect(build.permissions).toEqual({ contents: 'read', packages: 'write' });
  expect(build.outputs?.digest).toBe(
    ['$', '{{ steps.build.outputs.digest }}'].join(''),
  );
  expect(announce.needs).toBe('build');
  expect(announce.permissions).toEqual({ contents: 'read' });
  const sops = announce.steps.filter(
    (step) => step.uses === './.github/actions/sops-secret',
  );
  expect(
    sops.map((step) => [step.with?.['secret-key'], step.with?.['env-name']]),
  ).toEqual([
    ['broker_app.app_id', 'BROKER_APP_ID'],
    ['broker_app.private_key', 'BROKER_APP_PRIVATE_KEY'],
  ]);
  const broker = announce.steps.find((step) => step.id === 'broker');
  expect(broker?.uses).toBe('actions/create-github-app-token@v2');
  expect(
    Object.fromEntries(
      Object.entries(broker?.with ?? {}).filter(([key]) =>
        key.startsWith('permission-'),
      ),
    ),
  ).toEqual({ 'permission-contents': 'write' });
});
it('executes strict validation before dispatching the build identity', () => {
  const source = yamlContract<Workflow>('source-workflow');
  const announce = jobNamed(source, 'announce');
  const dispatch = announce.steps.find(
    (step) => step.name === 'Announce image digest',
  );
  if (dispatch?.run === undefined) {
    throw new Error('missing announcement script');
  }
  const script = dispatch.run.replace(DISPATCH_COMMAND, 'printf dispatched');
  const validEnvironment = Object.fromEntries([
    ['BUILD_DIGEST', `sha256:${'a'.repeat(DIGEST_LENGTH)}`],
    ['IMAGE_REPOSITORY', 'ghcr.io/example/app/web'],
    ['PATH', process.env.PATH],
    ['SOURCE_REF', 'refs/heads/main'],
    ['SOURCE_REPOSITORY', 'example/app'],
    ['SOURCE_RUN_ID', '42'],
    ['SOURCE_SHA', 'b'.repeat(SHA_LENGTH)],
  ]);
  expect(
    runProcess('bash', ACTUAL_UPSTREAM, ['-c', script], validEnvironment),
  ).toMatchObject({ status: 0, stdout: 'dispatched' });
  for (const [key, value] of [
    ['BUILD_DIGEST', 'sha256:abc'],
    ['SOURCE_SHA', 'not-a-sha'],
    ['SOURCE_RUN_ID', '0'],
    ['SOURCE_REPOSITORY', 'other/repo'],
    ['IMAGE_REPOSITORY', 'ghcr.io/example/other/web'],
  ]) {
    const invalid = { ...validEnvironment, [key]: value };
    expect(
      runProcess('bash', ACTUAL_UPSTREAM, ['-c', script], invalid).status,
    ).not.toBe(0);
  }
  for (const field of [
    'source_repository',
    'source_ref',
    'source_sha',
    'source_run_id',
    'image_repository',
    'digest',
  ]) {
    expect(dispatch.run).toContain(`client_payload[${field}]`);
  }
});
it('pins ordering, exact-SHA deployment, and read-only drift policies', () => {
  const table = document.split('<!-- contract:transition-table -->')[1] ?? '';
  const rows = table
    .split('\n\n')[0]
    ?.split('\n')
    .filter((line) => line.startsWith('| ') && !line.includes('---'))
    .slice(1)
    .map((line) =>
      line
        .split('|')
        .map((cell) => cell.trim())
        .slice(1, TABLE_COLUMN_END),
    );
  expect(rows).toEqual([
    ['same SHA, same digest', '`duplicate-noop`'],
    ['same SHA, different digest', '`reject`'],
    ['candidate descends from current', '`write`'],
    ['candidate is an ancestor of current', '`stale-noop`'],
    ['candidate diverged or ancestry is unprovable', '`reject`'],
    ['audited rollback to an ancestor', '`write-rollback`'],
  ]);
  const deploy = yamlContract<Workflow>('deploy-guard');
  const deployJob = jobNamed(deploy, 'deploy');
  expect(deploy.concurrency).toEqual({
    group: 'production',
    'cancel-in-progress': false,
  });
  expect(deployJob.needs).toBe('gate');
  expect(deployJob.if).toContain("needs.gate.result == 'success'");
  expect(deployJob.if).toContain('needs.gate.outputs.gated-sha == github.sha');
  const guardIndex = deployJob.steps.findIndex(
    (step) => step.name === 'Verify exact current main',
  );
  const mutationIndex = deployJob.steps.findIndex(
    (step) => step.name === 'Mutate and read back',
  );
  expect(deployJob.steps[guardIndex]?.run).toContain(
    'git ls-remote origin refs/heads/main',
  );
  expect(guardIndex).toBeLessThan(mutationIndex);
  const home = yamlContract<{
    readonly 'drift-on-mismatch': string;
    readonly 'drift-token-permissions': Mapping;
    readonly 'drift-writes': ReadonlyArray<string>;
    readonly 'writer-token-permissions': Mapping;
  }>('home-policy');
  expect(home['writer-token-permissions']).toEqual({
    contents: 'write',
    'pull-requests': 'write',
  });
  expect(home['drift-token-permissions']).toEqual({ contents: 'read' });
  expect(home['drift-on-mismatch']).toBe('wait-and-recheck');
  expect(home['drift-writes']).toEqual([]);
});

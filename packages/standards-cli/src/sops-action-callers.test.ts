import { afterEach, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { cleanupTmpDirs, write } from './cli-test-support';
import {
  buildUpstream,
  engineFor,
  SKILL,
} from './managed-files-symlink-test-support';
import { collectSopsActionCallerProblems } from './sops-action-callers';

const ACTION = '.github/actions/sops-secret/action.yml';
const OUTPUT_ACTION = 'outputs:\n  value: { value: secret }\n';
const { initConsumer, run } = engineFor({ ...process.env });
afterEach(cleanupTmpDirs);

it.each(['.github/workflows/deploy.yml', '.github/actions/deploy/action.yml'])(
  'refuses a consumer-owned legacy SOPS caller before mirror writes: %s',
  async (path) => {
    const old = buildUpstream({ extra: [ACTION] });
    write(old, ACTION, 'inputs: { env-name: { required: true } }\n');
    const { consumer } = initConsumer(old);
    write(
      consumer,
      path,
      'jobs:\n  deploy:\n    steps:\n      - uses: ./.github/actions/sops-secret\n        with: { env-name: DEPLOY_TOKEN }\n',
    );
    const up = buildUpstream({ extra: [ACTION] });
    write(up, ACTION, OUTPUT_ACTION);
    write(up, SKILL, 'new skill\n');
    const previous = readFileSync(join(consumer, SKILL), 'utf8');
    const result = run(consumer, ['sync', '--from', up, '--dir', consumer]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${path} still passes env-name`);
    expect(readFileSync(join(consumer, SKILL), 'utf8')).toBe(previous);
    write(consumer, ACTION, OUTPUT_ACTION);
    expect(
      (await collectSopsActionCallerProblems(consumer)).join(' '),
    ).toContain(path);
  },
);

it.each(['./.github/actions/sops-secret/', './.github/actions/./sops-secret'])(
  'recognizes equivalent local action reference %s',
  async (reference) => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, ACTION, OUTPUT_ACTION);
    write(
      consumer,
      '.github/workflows/custom.yml',
      `jobs:\n  deploy:\n    steps:\n      - uses: ${reference}\n        with: { env-name: TOKEN }\n`,
    );
    expect(
      (await collectSopsActionCallerProblems(consumer)).join(' '),
    ).toContain('still passes env-name');
  },
);

it('follows nested local composites outside .github and handles cycles', async () => {
  const old = buildUpstream({ extra: [ACTION] });
  write(old, ACTION, 'inputs: { env-name: { required: true } }\n');
  const { consumer } = initConsumer(old);
  write(
    consumer,
    '.github/workflows/deploy.yml',
    'jobs: { deploy: { steps: [{ uses: ./actions/deploy }] } }\n',
  );
  write(
    consumer,
    'actions/deploy/action.yml',
    'runs: { using: composite, steps: [{ uses: ./actions/nested }] }\n',
  );
  write(
    consumer,
    'actions/nested/action.yaml',
    'runs:\n  using: composite\n  steps:\n    - uses: ./actions/deploy\n    - uses: ./.github/actions/sops-secret/\n      with: { env-name: TOKEN }\n',
  );
  const up = buildUpstream({ extra: [ACTION] });
  write(up, ACTION, OUTPUT_ACTION);
  write(up, SKILL, 'new skill\n');
  const previous = readFileSync(join(consumer, SKILL), 'utf8');
  const result = run(consumer, ['sync', '--from', up, '--dir', consumer]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(
    'actions/nested/action.yaml still passes env-name',
  );
  expect(readFileSync(join(consumer, SKILL), 'utf8')).toBe(previous);
  write(consumer, ACTION, OUTPUT_ACTION);
  expect((await collectSopsActionCallerProblems(consumer)).join(' ')).toContain(
    'actions/nested/action.yaml',
  );
});

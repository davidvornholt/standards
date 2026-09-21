import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ACTUAL_UPSTREAM } from './cli-test-support';
import { expression } from './standards-sync-broker-workflow-contract';

const readWorkflow = (name: string) =>
  parseYaml(
    readFileSync(join(ACTUAL_UPSTREAM, '.github/workflows', name), 'utf8'),
  ) as {
    readonly on: Readonly<Record<string, unknown>>;
    readonly jobs: Readonly<Record<string, { readonly environment?: string }>>;
  };

const sync = readWorkflow('standards-sync.yml');
const notify = readWorkflow('notify-pause.yml');

describe('automation bootstrap secret scope', () => {
  it('binds both secret-consuming jobs to the same repository-selected environment', () => {
    const selectedEnvironment = expression('vars.CI_SECRETS_ENVIRONMENT');
    expect(sync.jobs.sync?.environment).toBe(selectedEnvironment);
    expect(notify.jobs.notify?.environment).toBe(selectedEnvironment);
    expect(sync.jobs.policy?.environment).toBeUndefined();
  });
});

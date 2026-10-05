// Runs the sync workflow's client ID presence check against encrypted secret
// files. A repository without ci.broker_app.client_id must keep minting with
// its App ID, so absence reports false instead of failing, while a file the
// check cannot read still fails the step.

import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import {
  ACTUAL_UPSTREAM,
  cleanupTmpDirs,
  mkTmp,
  runProcess,
  write,
  yamlRunScript,
} from './cli-test-support';
import { detectClientIdName } from './standards-sync-broker-workflow-contract';

const WORKFLOW = join(ACTUAL_UPSTREAM, '.github/workflows/standards-sync.yml');
const encrypted = (data: string): string =>
  `ENC[AES256_GCM,data:${data},iv:aXY=,tag:dGFn,type:str]`;

afterEach(cleanupTmpDirs);

const detect = (secrets: string | null) => {
  const root = mkTmp('client-id-presence-');
  const workspace = join(root, 'workspace');
  const runtime = join(root, 'runtime');
  const output = join(root, 'github-output');
  mkdirSync(workspace);
  write(runtime, 'bunfig.toml', '');
  if (secrets !== null) {
    write(workspace, 'secrets/ci.yaml', secrets);
  }
  const result = runProcess(
    'bash',
    workspace,
    ['-e', '-c', yamlRunScript(WORKFLOW, detectClientIdName)],
    {
      ...process.env,
      ...Object.fromEntries([
        ['GITHUB_OUTPUT', output],
        ['GITHUB_WORKSPACE', workspace],
        ['PATH', `${dirname(process.execPath)}:${process.env.PATH ?? ''}`],
        ['STANDARDS_SYNC_RUNTIME', runtime],
      ]),
    },
  );
  return {
    output: existsSync(output) ? readFileSync(output, 'utf8') : '',
    result,
  };
};

const brokerApp = (lines: ReadonlyArray<string>): string =>
  [
    'ci:',
    `    ntfy_topic_url: ${encrypted('dXJs')}`,
    ...lines,
    'sops:',
    '    version: 3.13.3',
    '',
  ].join('\n');

describe('Standards sync client ID presence check', () => {
  it.each([
    [
      'a file provisioned before client IDs were stored',
      readFileSync(
        join(import.meta.dir, 'fixtures/sops-3.13-two-age-key-groups.yaml'),
        'utf8',
      ),
      'false',
    ],
    [
      'the source repository secrets, which hold a client ID',
      readFileSync(join(ACTUAL_UPSTREAM, 'secrets/ci.yaml'), 'utf8'),
      'true',
    ],
    [
      'a direct dotted client ID key',
      brokerApp([`    broker_app.client_id: ${encrypted('Y2xp')}`]),
      'true',
    ],
    [
      'a client ID whose value the strict resolver must still validate',
      brokerApp([
        '    broker_app:',
        `        app_id: ${encrypted('MQ==')}`,
        `        client_id: ${encrypted('')}`,
      ]),
      'true',
    ],
    ['no broker App mapping', brokerApp([]), 'false'],
    [
      'a broker App value that is not a mapping',
      brokerApp([`    broker_app: ${encrypted('eA==')}`]),
      'false',
    ],
  ])('reports %s', (_label, secrets, present) => {
    const { output, result } = detect(secrets);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(output).toBe(`present=${present}\n`);
  });

  it.each([
    ['the secret file is unparseable', 'ci: [\n'],
    ['the secret file is missing', null],
  ])('fails without an output when %s', (_label, secrets) => {
    const { output, result } = detect(secrets);

    expect(result.status).not.toBe(0);
    expect(output).toBe('');
  });
});

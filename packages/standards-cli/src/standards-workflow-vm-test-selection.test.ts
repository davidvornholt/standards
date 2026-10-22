// Runs the Nix job's VM test selection against a shallow checkout, as on a
// runner. The test may be skipped only when the diff provably leaves every
// path it reads unchanged.

import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import {
  ACTUAL_UPSTREAM,
  cleanupTmpDirs,
  mkTmp,
  runProcess,
  write,
  yamlRunScript,
} from './cli-test-support';

const WORKFLOW = join(ACTUAL_UPSTREAM, '.github/workflows/standards.yml');
const SELECT_STEP = 'Select app-release VM test';
const SHA_LENGTH = 40;
const BASE_FILES = [
  'flake.nix',
  'flake.lock',
  'nix/app-release/vm-test.py',
  'nix/standards-cli.nix',
  '.github/workflows/standards.yml',
  '.github/workflows/standards-sync.yml',
  '.agents/skills/prs/SKILL.md',
];

const git = (cwd: string, ...args: Array<string>): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

afterEach(cleanupTmpDirs);

const select = (change: (work: string) => void, base?: string) => {
  const root = mkTmp('vm-test-selection-');
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  const checkout = join(root, 'checkout');
  const output = join(root, 'github-output');
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(remote, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
  git(root, 'clone', '--quiet', remote, work);
  git(work, 'config', 'commit.gpgsign', 'false');
  git(work, 'config', 'user.name', 'fixture');
  git(work, 'config', 'user.email', 'fixture@example.invalid');
  for (const path of BASE_FILES) {
    write(work, path, 'base\n');
  }
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '-m', 'base');
  const baseSha = git(work, 'rev-parse', 'HEAD');
  change(work);
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '--allow-empty', '-m', 'head');
  git(work, 'push', '--quiet', 'origin', 'main');
  git(root, 'clone', '--quiet', '--depth=1', `file://${remote}`, checkout);
  const result = runProcess(
    'bash',
    checkout,
    ['-c', yamlRunScript(WORKFLOW, SELECT_STEP)],
    {
      ...process.env,
      ...Object.fromEntries([
        ['BASE_SHA', base ?? baseSha],
        ['GITHUB_OUTPUT', output],
      ]),
    },
  );
  return {
    output: existsSync(output) ? readFileSync(output, 'utf8') : '',
    result,
  };
};

const edit =
  (...paths: Array<string>) =>
  (work: string): void => {
    for (const path of paths) {
      write(work, path, 'head\n');
    }
  };

describe('Nix job app-release VM test selection', () => {
  it.each([
    ['a skill change', 'false', edit('.agents/skills/prs/SKILL.md')],
    ['another workflow', 'false', edit('.github/workflows/standards-sync.yml')],
    ['the CLI derivation', 'false', edit('nix/standards-cli.nix')],
    [
      'a deleted unrelated file',
      'false',
      (work: string) => rmSync(join(work, '.agents/skills/prs/SKILL.md')),
    ],
    ['an identical tree', 'false', () => undefined],
    ['the VM test source', 'true', edit('nix/app-release/vm-test.py')],
    ['a new app-release file', 'true', edit('nix/app-release/src/new.py')],
    ['the flake', 'true', edit('flake.nix')],
    ['the nixpkgs pin', 'true', edit('flake.lock')],
    ['this workflow', 'true', edit('.github/workflows/standards.yml')],
    [
      'the VM test source beside unrelated files',
      'true',
      edit('.agents/skills/prs/SKILL.md', 'nix/app-release/vm-test.py'),
    ],
  ])('for %s, reports selected=%s', (_label, selected, change) => {
    const { output, result } = select(change);

    expect(result.status).toBe(0);
    expect(output).toBe(`selected=${selected}\n`);
  });

  it.each([
    ['no base', ''],
    ['a malformed base', 'main'],
    ['a base the remote does not have', 'f'.repeat(SHA_LENGTH)],
    ['the all-zero base of a new branch', '0'.repeat(SHA_LENGTH)],
  ])('selects the test for %s', (_label, base) => {
    const { output, result } = select(
      edit('.agents/skills/prs/SKILL.md'),
      base,
    );

    expect(result.status).toBe(0);
    expect(output).toBe('selected=true\n');
  });
});

// Runs the quality job's Nix package step with a stand-in `nix` that answers
// evaluation and records what it is asked to build.

import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
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
const BUILD_STEP = 'Build the Nix packages and their source check';

const FAKE_NIX = `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *builtins.currentSystem*) printf x86_64-linux ;;
  eval\\ .#packages.x86_64-linux\\ *)
    [ "$PACKAGES" = fail ] && { echo "flake does not provide attribute 'packages'" >&2; exit 1; }
    printf '%s\\n' "$PACKAGES" ;;
  build\\ *) printf '%s\\n' "$@" > "$BUILD_LOG" ;;
  *) echo "unexpected nix $*" >&2; exit 2 ;;
esac
`;

afterEach(cleanupTmpDirs);

const runBuildStep = (packages: string) => {
  const root = mkTmp('package-build-');
  const bin = join(root, 'bin');
  const buildLog = join(root, 'build-log');
  write(bin, 'nix', FAKE_NIX);
  chmodSync(join(bin, 'nix'), 0o755);
  const result = runProcess(
    'bash',
    root,
    ['-c', yamlRunScript(WORKFLOW, BUILD_STEP)],
    {
      ...process.env,
      ...Object.fromEntries([
        ['PATH', `${bin}:${process.env.PATH ?? ''}`],
        ['PACKAGES', packages],
        ['BUILD_LOG', buildLog],
      ]),
    },
  );
  return {
    built: existsSync(buildLog)
      ? readFileSync(buildLog, 'utf8').trim().split('\n')
      : [],
    result,
  };
};

describe('canonical standards workflow package build', () => {
  it('builds the package source check and every package the flake exposes', () => {
    const { built, result } = runBuildStep('["default","rota-cli"]');

    expect(result.status).toBe(0);
    expect(built).toEqual([
      'build',
      '.#checks.x86_64-linux.package-source',
      '.#packages.x86_64-linux.default',
      '.#packages.x86_64-linux.rota-cli',
      '--no-link',
      '-L',
    ]);
  });

  it('builds only the source check when the flake exposes no package for the system', () => {
    const { built, result } = runBuildStep('[]');

    expect(result.status).toBe(0);
    expect(built).toEqual([
      'build',
      '.#checks.x86_64-linux.package-source',
      '--no-link',
      '-L',
    ]);
  });

  it('fails without building when the packages cannot be listed', () => {
    const { built, result } = runBuildStep('fail');

    expect(result.status).not.toBe(0);
    expect(built).toEqual([]);
  });
});

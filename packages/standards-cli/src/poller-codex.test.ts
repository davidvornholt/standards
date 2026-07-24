import { afterEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { runCodex } from './poller-codex';
import type { PollerConfig } from './poller-config';
import { OUTCOME_DIR } from './poller-protocol';

const dirs: Array<string> = [];
const MAX_FAILURE_LENGTH = 2100;
const LONG_ERROR_LENGTH = 2500;
const MS_PER_MINUTE = 60_000;
const TIMEOUT_MS = 100;
const MAX_TIMEOUT_ELAPSED_MS = 750;
const GIT_COMMON_DIR = '/tmp/cache/owner/repo.git';
const originalGhToken = process.env.GH_TOKEN;
const originalGithubToken = process.env.GITHUB_TOKEN;
const originalGitToken = process.env.STANDARDS_POLLER_GIT_TOKEN;
const config = {
  repos: ['owner/repo'],
  model: 'gpt-test',
  reasoningEffort: 'high',
  maxJobsPerTick: 1,
  staleClaimHours: 3,
  extraCodexArgs: ['--ephemeral'],
  runTimeoutMinutes: 2,
  cacheDir: '/tmp',
} satisfies PollerConfig;

const runOptions = (
  workDir: string,
  prompt = 'do work',
  pollerConfig = config,
) => ({
  workDir,
  gitCommonDir: GIT_COMMON_DIR,
  prompt,
  config: pollerConfig,
});

const runScript =
  (source: string): NonNullable<Parameters<typeof runCodex>[1]> =>
  (_file, _args, options) =>
    spawn(process.execPath, ['-e', source], options);

const makeWorkDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'poller-codex-'));
  dirs.push(dir);
  return dir;
};

const runFailure = (source: string, prompt = 'do work') =>
  runCodex(runOptions(makeWorkDir(), prompt), runScript(source));

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  process.env.GH_TOKEN = originalGhToken;
  process.env.GITHUB_TOKEN = originalGithubToken;
  process.env.STANDARDS_POLLER_GIT_TOKEN = originalGitToken;
});

describe('runCodex', () => {
  it('cleans stale output and preserves GitHub auth', async () => {
    const dir = makeWorkDir();
    mkdirSync(join(dir, OUTCOME_DIR));
    writeFileSync(join(dir, OUTCOME_DIR, 'stale'), 'x');
    process.env.GH_TOKEN = 'gh-secret';
    process.env.GITHUB_TOKEN = 'github-secret';
    process.env.STANDARDS_POLLER_GIT_TOKEN = 'git-secret';
    let capturedArgs: ReadonlyArray<string> = [];
    let capturedEnv: Record<string, string | undefined> = {};
    const result = await runCodex(runOptions(dir), (_file, args, options) => {
      capturedArgs = args;
      capturedEnv = options.env;
      return spawn(process.execPath, ['-e', ''], options);
    });
    expect(result).toEqual({ succeeded: true, failure: null });
    expect(capturedArgs).toContain('--ephemeral');
    const addDirIndex = capturedArgs.indexOf('--add-dir');
    expect(addDirIndex).toBeGreaterThan(-1);
    expect(capturedArgs[addDirIndex + 1]).toBe(GIT_COMMON_DIR);
    expect(capturedEnv.GH_TOKEN).toBe('gh-secret');
    expect(capturedEnv.GITHUB_TOKEN).toBe('github-secret');
    expect(capturedEnv.STANDARDS_POLLER_GIT_TOKEN).toBe('git-secret');
    expect(existsSync(join(dir, OUTCOME_DIR))).toBeFalse();
  });

  it('returns process stderr for failures', async () => {
    const result = await runFailure(
      "process.stderr.write('last process output'); process.exit(1)",
    );
    expect(result.failure).toContain('exit status 1');
    expect(result.failure).toContain('last process output');
  });

  it('keeps only a bounded tail while continuously draining stderr', async () => {
    const result = await runFailure(
      "const { writeSync } = require('node:fs'); const chunk = 'x'.repeat(100_000); for (let index = 0; index < 200; index += 1) writeSync(2, chunk); writeSync(2, '\\nROOT CAUSE: streamed safely\\n'); process.exit(1)",
    );
    expect(result.failure).toContain('exit status 1');
    expect(result.failure).toContain('ROOT CAUSE: streamed safely');
    expect(result.failure).not.toContain('ENOBUFS');
    expect(result.failure?.length).toBeLessThanOrEqual(MAX_FAILURE_LENGTH);
  });

  it('preserves stderr before long Unicode trailing whitespace', async () => {
    const result = await runFailure(
      "process.stderr.write('ROOT CAUSE: model requires a newer CLI\\n'); process.stderr.write('\\u2003'.repeat(20_000)); process.exit(1)",
    );
    expect(result.failure).toContain('ROOT CAUSE: model requires a newer CLI');
    expect(result.failure).not.toContain('\uFFFD');
  });

  it('ignores an incomplete UTF-8 sequence after Unicode whitespace', async () => {
    const result = await runFailure(
      "const { writeSync } = require('node:fs'); writeSync(2, Buffer.from('ROOT CAUSE: keep me\\n')); writeSync(2, Buffer.from('\\u2003'.repeat(10_000))); writeSync(2, Buffer.from([0xe2])); process.exit(1)",
    );
    expect(result.failure).toContain('ROOT CAUSE: keep me');
    expect(result.failure).not.toContain('\uFFFD');
  });
});

describe('runCodex failure containment', () => {
  it('bounds a timeout when a descendant inherits stderr', async () => {
    const started = performance.now();
    const result = await runCodex(
      runOptions(makeWorkDir(), 'do work', {
        ...config,
        runTimeoutMinutes: TIMEOUT_MS / MS_PER_MINUTE,
      }),
      runScript(
        "const { spawn } = require('node:child_process'); process.stderr.write('diagnostic before timeout\\n'); spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: ['ignore', 'ignore', 2] }); setTimeout(() => {}, 1500)",
      ),
    );
    expect(performance.now() - started).toBeLessThan(MAX_TIMEOUT_ELAPSED_MS);
    expect(result.failure).toContain(`timed out after ${TIMEOUT_MS} ms`);
    expect(result.failure).toContain('diagnostic before timeout');
  });

  it('does not echo the prompt in a process failure', async () => {
    const prompt = 'a very long agent prompt';
    const result = await runFailure(
      "process.stderr.write('ERROR: model requires a newer CLI'); process.exit(1)",
      prompt,
    );
    expect(result.failure).toContain('exit status 1');
    expect(result.failure).toContain('ERROR: model requires a newer CLI');
    expect(result.failure).not.toContain(prompt);
  });

  it('reports the terminating signal when there is no exit status', async () => {
    const result = await runFailure("process.kill(process.pid, 'SIGTERM')");
    expect(result.failure).toContain('signal SIGTERM');
  });

  it('contains subprocess setup failures', async () => {
    const result = await runCodex(runOptions(makeWorkDir()), () => {
      throw new Error('spawn setup failed');
    });
    expect(result.failure).toBe('codex exec failed: spawn setup failed');
  });

  it('reserves bounded space for stderr and a long capture failure', async () => {
    const result = await runCodex(
      runOptions(makeWorkDir()),
      (_file, _args, options) => {
        const child = spawn(
          process.execPath,
          [
            '-e',
            "process.stderr.write('ROOT CAUSE: partial diagnostic'); setTimeout(() => process.exit(7), 20)",
          ],
          options,
        );
        child.stderr.once('data', () => {
          queueMicrotask(() => {
            child.stderr.emit(
              'error',
              new Error('x'.repeat(LONG_ERROR_LENGTH)),
            );
          });
        });
        return child;
      },
    );
    expect(result.failure).toContain('ROOT CAUSE: partial diagnostic');
    expect(result.failure).toContain('stderr capture failed:');
    expect(result.failure?.length).toBeLessThanOrEqual(MAX_FAILURE_LENGTH);
  });
});

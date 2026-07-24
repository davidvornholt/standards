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
const EXPECTED_TIMEOUT_MS = 120_000;
const MAX_FAILURE_LENGTH = 2100;
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

const runOptions = (workDir: string, prompt = 'do work') => ({
  workDir,
  gitCommonDir: GIT_COMMON_DIR,
  prompt,
  config,
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

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  process.env.GH_TOKEN = originalGhToken;
  process.env.GITHUB_TOKEN = originalGithubToken;
  process.env.STANDARDS_POLLER_GIT_TOKEN = originalGitToken;
});

describe('runCodex', () => {
  it('cleans stale output, preserves GitHub auth, and applies the timeout', async () => {
    const dir = makeWorkDir();
    mkdirSync(join(dir, OUTCOME_DIR));
    writeFileSync(join(dir, OUTCOME_DIR, 'stale'), 'x');
    process.env.GH_TOKEN = 'gh-secret';
    process.env.GITHUB_TOKEN = 'github-secret';
    process.env.STANDARDS_POLLER_GIT_TOKEN = 'git-secret';
    let captured:
      | {
          readonly args: ReadonlyArray<string>;
          readonly timeout: number;
          readonly env: Record<string, string | undefined>;
        }
      | undefined;
    const result = await runCodex(runOptions(dir), (_file, args, options) => {
      captured = {
        args,
        timeout: options.timeout,
        env: options.env,
      };
      return spawn(process.execPath, ['-e', ''], options);
    });
    expect(result).toEqual({ succeeded: true, failure: null });
    const capturedArgs = captured?.args ?? [];
    expect(capturedArgs).toContain('--ephemeral');
    const addDirIndex = capturedArgs.indexOf('--add-dir');
    expect(addDirIndex).toBeGreaterThan(-1);
    expect(capturedArgs[addDirIndex + 1]).toBe(GIT_COMMON_DIR);
    expect(captured?.timeout).toBe(EXPECTED_TIMEOUT_MS);
    expect(captured?.env.GH_TOKEN).toBe('gh-secret');
    expect(captured?.env.GITHUB_TOKEN).toBe('github-secret');
    expect(captured?.env.STANDARDS_POLLER_GIT_TOKEN).toBe('git-secret');
    expect(existsSync(join(dir, OUTCOME_DIR))).toBeFalse();
  });

  it('returns process stderr for failures', async () => {
    const result = await runCodex(
      runOptions(makeWorkDir()),
      runScript("process.stderr.write('last process output'); process.exit(1)"),
    );
    expect(result.failure).toContain('exit status 1');
    expect(result.failure).toContain('last process output');
  });

  it('keeps only a bounded tail while continuously draining stderr', async () => {
    const result = await runCodex(
      runOptions(makeWorkDir()),
      runScript(
        "const { writeSync } = require('node:fs'); const chunk = 'x'.repeat(100_000); for (let index = 0; index < 200; index += 1) writeSync(2, chunk); writeSync(2, '\\nROOT CAUSE: streamed safely\\n'); process.exit(1)",
      ),
    );
    expect(result.failure).toContain('exit status 1');
    expect(result.failure).toContain('ROOT CAUSE: streamed safely');
    expect(result.failure).not.toContain('ENOBUFS');
    expect(result.failure?.length).toBeLessThanOrEqual(MAX_FAILURE_LENGTH);
  });

  it('preserves stderr before long Unicode trailing whitespace', async () => {
    const result = await runCodex(
      runOptions(makeWorkDir()),
      runScript(
        "process.stderr.write('ROOT CAUSE: model requires a newer CLI\\n'); process.stderr.write('\\u2003'.repeat(20_000)); process.exit(1)",
      ),
    );
    expect(result.failure).toContain('ROOT CAUSE: model requires a newer CLI');
    expect(result.failure).not.toContain('\uFFFD');
  });
});

describe('runCodex failure containment', () => {
  it('does not echo the prompt in a process failure', async () => {
    const prompt = 'a very long agent prompt';
    const result = await runCodex(
      runOptions(makeWorkDir(), prompt),
      runScript(
        "process.stderr.write('ERROR: model requires a newer CLI'); process.exit(1)",
      ),
    );
    expect(result.failure).toContain('exit status 1');
    expect(result.failure).toContain('ERROR: model requires a newer CLI');
    expect(result.failure).not.toContain(prompt);
  });

  it('reports the terminating signal when there is no exit status', async () => {
    const result = await runCodex(
      runOptions(makeWorkDir()),
      runScript("process.kill(process.pid, 'SIGTERM')"),
    );
    expect(result.failure).toContain('signal SIGTERM');
    expect(result.failure).not.toContain('do work');
  });

  it('contains subprocess setup failures', async () => {
    const result = await runCodex(runOptions(makeWorkDir()), () => {
      throw new Error('spawn setup failed');
    });
    expect(result).toEqual({
      succeeded: false,
      failure: 'codex exec failed: spawn setup failed',
    });
  });

  it('preserves the process result when stderr capture fails', async () => {
    const result = await runCodex(
      runOptions(makeWorkDir()),
      (_file, _args, options) => {
        const child = spawn(
          process.execPath,
          ['-e', 'setTimeout(() => process.exit(7), 20)'],
          options,
        );
        queueMicrotask(() => {
          child.stderr.emit('error', new Error('capture read failed'));
        });
        return child;
      },
    );
    expect(result.failure).toContain('exit status 7');
    expect(result.failure).toContain(
      'stderr capture failed: capture read failed',
    );
  });
});

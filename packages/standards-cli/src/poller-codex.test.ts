import { afterEach, describe, expect, it } from 'bun:test';
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
const EXCESSIVE_TRAILING_WHITESPACE_LENGTH = 2001;
const GIT_COMMON_DIR = '/tmp/cache/owner/repo.git';
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

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  process.env.GH_TOKEN = undefined;
});

describe('runCodex', () => {
  it('cleans stale output, scrubs direct tokens, and applies the timeout', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'poller-codex-'));
    dirs.push(workDir);
    mkdirSync(join(workDir, OUTCOME_DIR));
    writeFileSync(join(workDir, OUTCOME_DIR, 'stale'), 'x');
    process.env.GH_TOKEN = 'secret';
    let captured:
      | {
          readonly args: ReadonlyArray<string>;
          readonly timeout: number;
          readonly token: string | undefined;
        }
      | undefined;
    const result = runCodex(runOptions(workDir), (_file, args, options) => {
      captured = {
        args,
        timeout: options.timeout,
        token: options.env.GH_TOKEN,
      };
    });
    expect(result).toEqual({ succeeded: true, failure: null });
    const capturedArgs = captured?.args ?? [];
    expect(capturedArgs).toContain('--ephemeral');
    const addDirIndex = capturedArgs.indexOf('--add-dir');
    expect(addDirIndex).toBeGreaterThan(-1);
    expect(capturedArgs[addDirIndex + 1]).toBe(GIT_COMMON_DIR);
    expect(captured?.timeout).toBe(EXPECTED_TIMEOUT_MS);
    expect(captured?.token).toBeUndefined();
    expect(existsSync(join(workDir, OUTCOME_DIR))).toBeFalse();
  });

  it('returns process stderr for failures and timeouts', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'poller-codex-'));
    dirs.push(workDir);
    const result = runCodex(runOptions(workDir), () => {
      const error = new Error('timed out') as Error & { stderr: string };
      error.stderr = 'last process output';
      throw error;
    });
    expect(result.succeeded).toBeFalse();
    expect(result.failure).toContain('timed out');
    expect(result.failure).toContain('last process output');
  });

  it('preserves stderr before trailing whitespace', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'poller-codex-'));
    dirs.push(workDir);
    const result = runCodex(runOptions(workDir), () => {
      const error = new Error('failed') as Error & { stderr: string };
      error.stderr = `ROOT CAUSE: model requires a newer CLI\n${' '.repeat(
        EXCESSIVE_TRAILING_WHITESPACE_LENGTH,
      )}`;
      throw error;
    });
    expect(result.failure).toContain('ROOT CAUSE: model requires a newer CLI');
  });

  it('replaces the echoed command line with the exit cause', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'poller-codex-'));
    dirs.push(workDir);
    const prompt = 'a very long agent prompt';
    const result = runCodex(runOptions(workDir, prompt), () => {
      const error = new Error(
        `Command failed: codex exec ${prompt}`,
      ) as Error & { stderr: string; status: number };
      error.stderr = 'ERROR: model requires a newer CLI';
      error.status = 1;
      throw error;
    });
    expect(result.succeeded).toBeFalse();
    expect(result.failure).toContain('exit status 1');
    expect(result.failure).toContain('ERROR: model requires a newer CLI');
    expect(result.failure).not.toContain(prompt);
  });

  it('reports the terminating signal when there is no exit status', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'poller-codex-'));
    dirs.push(workDir);
    const result = runCodex(runOptions(workDir), () => {
      const error = new Error('Command failed: codex exec do work') as Error & {
        signal: string;
      };
      error.signal = 'SIGTERM';
      throw error;
    });
    expect(result.succeeded).toBeFalse();
    expect(result.failure).toContain('signal SIGTERM');
    expect(result.failure).not.toContain('do work');
  });
});

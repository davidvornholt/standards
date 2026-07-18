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
    const result = runCodex(
      workDir,
      'do work',
      config,
      (_file, args, options) => {
        captured = {
          args,
          timeout: options.timeout,
          token: options.env.GH_TOKEN,
        };
      },
    );
    expect(result).toEqual({ succeeded: true, failure: null });
    expect(captured?.args).toContain('--ephemeral');
    expect(captured?.timeout).toBe(EXPECTED_TIMEOUT_MS);
    expect(captured?.token).toBeUndefined();
    expect(existsSync(join(workDir, OUTCOME_DIR))).toBeFalse();
  });

  it('returns process stderr for failures and timeouts', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'poller-codex-'));
    dirs.push(workDir);
    const result = runCodex(workDir, 'do work', config, () => {
      const error = new Error('timed out') as Error & { stderr: string };
      error.stderr = 'last process output';
      throw error;
    });
    expect(result.succeeded).toBeFalse();
    expect(result.failure).toContain('timed out');
    expect(result.failure).toContain('last process output');
  });
});

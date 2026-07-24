// Codex invocation for poller jobs. The agent runs headless inside the job
// worktree and hands results back through the outcome file — never stdout,
// which is unreliable once agent tools are active. The poller then verifies
// effects (commits, diffs, gates) instead of trusting the narration.

import { execFileSync } from 'node:child_process';
import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { isRecord } from './github-settings-parse';
import type { PollerConfig } from './poller-config';
import { OUTCOME_DIR } from './poller-protocol';

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND;
const STDERR_SNIPPET_LIMIT = 2000;
const UTF8_MAX_BYTES_PER_CHARACTER = 4;
const STDERR_READ_LIMIT = STDERR_SNIPPET_LIMIT * UTF8_MAX_BYTES_PER_CHARACTER;
const STDERR_SCAN_CHUNK_SIZE = 8192;
const ASCII_WHITESPACE = new Set(Buffer.from('\t\n\v\f\r '));

export type CodexRunResult = {
  readonly succeeded: boolean;
  readonly failure: string | null;
};

type CodexExecutor = (
  file: string,
  args: ReadonlyArray<string>,
  options: {
    readonly encoding: 'utf8';
    readonly timeout: number;
    readonly stdio: ['ignore', 'ignore', number];
    readonly env: Record<string, string | undefined>;
  },
) => unknown;

const defaultExecutor: CodexExecutor = execFileSync;

type CodexRunOptions = {
  readonly workDir: string;
  readonly gitCommonDir: string;
  readonly prompt: string;
  readonly config: PollerConfig;
};

const exitCause = (details: Record<string, unknown>): string => {
  if (typeof details.status === 'number') {
    return `exit status ${details.status}`;
  }
  if (typeof details.signal === 'string') {
    return `signal ${details.signal}`;
  }
  return 'unknown exit cause';
};

// Codex deliberately inherits the poller's authenticated GitHub environment.
// The agent uses `gh` for review-fix ledger operations and PR metadata, while
// the poller still owns verified commit publication, labels, and ready/merge
// transitions.
const agentEnv = (): Record<string, string | undefined> => ({ ...process.env });

const stderrSnippet = (fd: number): string => {
  let end = fstatSync(fd).size;
  const scan = Buffer.allocUnsafe(STDERR_SCAN_CHUNK_SIZE);
  while (end > 0) {
    const length = Math.min(end, scan.length);
    const start = end - length;
    readSync(fd, scan, 0, length, start);
    let index = length - 1;
    while (index >= 0 && ASCII_WHITESPACE.has(scan[index] ?? 0)) {
      index -= 1;
    }
    if (index >= 0) {
      end = start + index + 1;
      break;
    }
    end = start;
  }
  const start = Math.max(0, end - STDERR_READ_LIMIT);
  const tail = Buffer.allocUnsafe(end - start);
  readSync(fd, tail, 0, tail.length, start);
  return tail.toString('utf8').trim().slice(-STDERR_SNIPPET_LIMIT);
};

export const runCodex = (
  options: CodexRunOptions,
  execute: CodexExecutor = defaultExecutor,
): CodexRunResult => {
  const { workDir, gitCommonDir, prompt, config } = options;
  rmSync(join(workDir, OUTCOME_DIR), { recursive: true, force: true });
  const logDir = mkdtempSync(join(tmpdir(), 'standards-poller-codex-'));
  const stderrFd = openSync(join(logDir, 'stderr.log'), 'w+');
  try {
    try {
      execute(
        'codex',
        [
          'exec',
          '--cd',
          workDir,
          '--sandbox',
          'workspace-write',
          '--add-dir',
          gitCommonDir,
          '-c',
          'sandbox_workspace_write.network_access=true',
          '-m',
          config.model,
          '-c',
          `model_reasoning_effort=${JSON.stringify(config.reasoningEffort)}`,
          ...config.extraCodexArgs,
          prompt,
        ],
        {
          encoding: 'utf8',
          timeout: config.runTimeoutMinutes * MS_PER_MINUTE,
          stdio: ['ignore', 'ignore', stderrFd],
          env: agentEnv(),
        },
      );
      return { succeeded: true, failure: null };
    } catch (error) {
      const details: Record<string, unknown> = isRecord(error) ? error : {};
      const captured = stderrSnippet(stderrFd);
      let stderr = captured;
      if (stderr === '' && typeof details.stderr === 'string') {
        stderr = details.stderr.trim().slice(-STDERR_SNIPPET_LIMIT);
      }
      const message = error instanceof Error ? error.message : String(error);
      // Node's "Command failed" message echoes the full command line, and the
      // prompt embedded in it would push stderr past the failure-comment
      // snippet limit — report the exit cause instead of the echoed command.
      const cause = message.startsWith('Command failed')
        ? exitCause(details)
        : message;
      return {
        succeeded: false,
        failure:
          stderr === ''
            ? `codex exec failed: ${cause}`
            : `codex exec failed (${cause}):\n${stderr}`,
      };
    }
  } finally {
    closeSync(stderrFd);
    rmSync(logDir, { recursive: true, force: true });
  }
};

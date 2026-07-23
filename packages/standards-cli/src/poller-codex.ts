// Codex invocation for poller jobs. The agent runs headless inside the job
// worktree and hands results back through the outcome file — never stdout,
// which is unreliable once agent tools are active. The poller then verifies
// effects (commits, diffs, gates) instead of trusting the narration.

import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { isRecord } from './github-settings-parse';
import type { PollerConfig } from './poller-config';
import { OUTCOME_DIR } from './poller-protocol';

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND;
const STDERR_SNIPPET_LIMIT = 2000;

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
    readonly stdio: readonly ['ignore', 'ignore', 'pipe'];
    readonly env: Record<string, string | undefined>;
  },
) => unknown;

const defaultExecutor: CodexExecutor = execFileSync;

const exitCause = (details: Record<string, unknown>): string => {
  if (typeof details.status === 'number') {
    return `exit status ${details.status}`;
  }
  if (typeof details.signal === 'string') {
    return `signal ${details.signal}`;
  }
  return 'unknown exit cause';
};

// Remove the poller's direct GitHub token variables so an approved Codex run
// cannot trivially bypass the protected-path and trust checks with API writes.
// The shared service identity is not credential-isolated: auth state and other
// ambient credentials in HOME remain readable as an explicitly accepted risk.
const agentEnv = (): Record<string, string | undefined> => {
  const env = { ...process.env };
  env.GH_TOKEN = undefined;
  env.GITHUB_TOKEN = undefined;
  env.STANDARDS_POLLER_GIT_TOKEN = undefined;
  return env;
};

export const runCodex = (
  workDir: string,
  prompt: string,
  config: PollerConfig,
  execute: CodexExecutor = defaultExecutor,
): CodexRunResult => {
  rmSync(join(workDir, OUTCOME_DIR), { recursive: true, force: true });
  try {
    execute(
      'codex',
      [
        'exec',
        '--cd',
        workDir,
        '--sandbox',
        'workspace-write',
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
        stdio: ['ignore', 'ignore', 'pipe'],
        env: agentEnv(),
      },
    );
    return { succeeded: true, failure: null };
  } catch (error) {
    const details: Record<string, unknown> = isRecord(error) ? error : {};
    const stderr =
      typeof details.stderr === 'string'
        ? details.stderr.trim().slice(-STDERR_SNIPPET_LIMIT)
        : '';
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
};

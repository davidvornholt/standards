import { type ChildProcess, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { createStderrCapture, withCaptureFailure } from './poller-codex-stderr';
import type { PollerConfig } from './poller-config';
import { OUTCOME_DIR } from './poller-protocol';

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND;

export type CodexRunResult = {
  readonly succeeded: boolean;
  readonly failure: string | null;
};

type CodexExecutor = (
  file: string,
  args: ReadonlyArray<string>,
  options: {
    readonly detached: true;
    readonly stdio: ['ignore', 'ignore', 'pipe'];
    readonly env: Record<string, string | undefined>;
  },
) => ChildProcess;

const defaultExecutor: CodexExecutor = (file, args, options) =>
  spawn(file, [...args], options);

type CodexRunOptions = {
  readonly workDir: string;
  readonly gitCommonDir: string;
  readonly prompt: string;
  readonly config: PollerConfig;
};

const exitCause = (
  status: number | null,
  signal: NodeJS.Signals | null,
): string => {
  if (status !== null) {
    return `exit status ${status}`;
  }
  return signal === null ? 'unknown exit cause' : `signal ${signal}`;
};

const failureResult = (cause: string, stderr = ''): CodexRunResult => ({
  succeeded: false,
  failure:
    stderr === ''
      ? `codex exec failed: ${cause}`
      : `codex exec failed (${cause}):\n${stderr}`,
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const timeoutCause = (timeout: number): string => {
  if (timeout % MS_PER_MINUTE !== 0) {
    return `timed out after ${timeout} ms`;
  }
  const minutes = timeout / MS_PER_MINUTE;
  return `timed out after ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
};

const terminateProcessTree = (child: ChildProcess): void => {
  try {
    if (process.platform === 'win32' || child.pid === undefined) {
      child.kill('SIGKILL');
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    // The process may have exited between the timeout and the kill.
  }
};

const awaitChild = (
  child: ChildProcess,
  capture: ReturnType<typeof createStderrCapture>,
  timeout: number,
): Promise<CodexRunResult> =>
  new Promise((resolve) => {
    let settled = false;
    let captureFailure: string | null = null;
    const settle = (result: CodexRunResult): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }
    };
    const failed = (cause: string): void => {
      let stderr = '';
      try {
        stderr = capture.finish();
      } catch (error) {
        captureFailure = errorMessage(error);
      }
      settle(failureResult(cause, withCaptureFailure(stderr, captureFailure)));
    };
    child.stderr?.on('data', (chunk: Buffer) => {
      try {
        capture.append(chunk);
      } catch (error) {
        captureFailure = errorMessage(error);
      }
    });
    child.stderr?.on('error', (error) => {
      captureFailure = errorMessage(error);
    });
    child.once('error', (error) => {
      failed(errorMessage(error));
    });
    child.once('close', (status, signal) => {
      if (status === 0) {
        settle({ succeeded: true, failure: null });
        return;
      }
      failed(exitCause(status, signal));
    });
    const timer = setTimeout(() => {
      terminateProcessTree(child);
      child.stderr?.destroy();
      failed(timeoutCause(timeout));
    }, timeout);
  });

export const runCodex = async (
  options: CodexRunOptions,
  execute: CodexExecutor = defaultExecutor,
): Promise<CodexRunResult> => {
  const { workDir, gitCommonDir, prompt, config } = options;
  try {
    rmSync(join(workDir, OUTCOME_DIR), { recursive: true, force: true });
  } catch (error) {
    return failureResult(
      `could not prepare the outcome directory: ${errorMessage(error)}`,
    );
  }
  let child: ChildProcess;
  try {
    child = execute(
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
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env },
      },
    );
  } catch (error) {
    return failureResult(errorMessage(error));
  }
  if (child.stderr === null) {
    child.kill();
    return failureResult('stderr capture was not available');
  }
  return await awaitChild(
    child,
    createStderrCapture(),
    config.runTimeoutMinutes * MS_PER_MINUTE,
  );
};

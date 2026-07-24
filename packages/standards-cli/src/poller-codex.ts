import { type ChildProcess, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import type { PollerConfig } from './poller-config';
import { OUTCOME_DIR } from './poller-protocol';

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND;
const STDERR_SNIPPET_LIMIT = 2000;
const STDERR_RETAINED_LIMIT = STDERR_SNIPPET_LIMIT * 2;
const LOW_SURROGATE_MIN = 0xdc_00;
const LOW_SURROGATE_MAX = 0xdf_ff;

export type CodexRunResult = {
  readonly succeeded: boolean;
  readonly failure: string | null;
};

type CodexExecutor = (
  file: string,
  args: ReadonlyArray<string>,
  options: {
    readonly timeout: number;
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

const unicodeSafeTail = (value: string, limit: number): string => {
  let start = Math.max(0, value.length - limit);
  const first = value.charCodeAt(start);
  if (first >= LOW_SURROGATE_MIN && first <= LOW_SURROGATE_MAX) {
    start += 1;
  }
  return value.slice(start);
};

const stderrCapture = () => {
  const decoder = new TextDecoder();
  let retained = '';
  let pendingWhitespace = '';
  const appendText = (text: string): void => {
    const content = text.trimEnd();
    if (content === '') {
      pendingWhitespace = unicodeSafeTail(
        pendingWhitespace + text,
        STDERR_RETAINED_LIMIT,
      );
      return;
    }
    retained = unicodeSafeTail(
      retained + pendingWhitespace + content,
      STDERR_RETAINED_LIMIT,
    );
    pendingWhitespace = unicodeSafeTail(
      text.slice(content.length),
      STDERR_RETAINED_LIMIT,
    );
  };
  return {
    append: (chunk: Buffer): void => {
      appendText(decoder.decode(chunk, { stream: true }));
    },
    finish: (): string => {
      appendText(decoder.decode());
      return unicodeSafeTail(retained.trim(), STDERR_SNIPPET_LIMIT);
    },
  };
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

const awaitChild = (
  child: ChildProcess,
  capture: ReturnType<typeof stderrCapture>,
): Promise<CodexRunResult> =>
  new Promise((resolve) => {
    let settled = false;
    let captureFailure: string | null = null;
    const settle = (result: CodexRunResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
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
      settle(failureResult(errorMessage(error)));
    });
    child.once('close', (status, signal) => {
      if (status === 0) {
        settle({ succeeded: true, failure: null });
        return;
      }
      let stderr = '';
      try {
        stderr = capture.finish();
      } catch (error) {
        captureFailure = errorMessage(error);
      }
      if (stderr === '' && captureFailure !== null) {
        stderr = `stderr capture failed: ${captureFailure}`;
      }
      settle(failureResult(exitCause(status, signal), stderr));
    });
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
        timeout: config.runTimeoutMinutes * MS_PER_MINUTE,
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
  return await awaitChild(child, stderrCapture());
};

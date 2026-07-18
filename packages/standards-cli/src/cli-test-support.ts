// Shared fixture, subprocess, and YAML-step helpers for the black-box CLI
// suites. Callers compose the full child-process environment so this module
// stays free of ambient process access.

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export type RunResult = { stdout: string; stderr: string; status: number };

export const ACTUAL_UPSTREAM = join(import.meta.dir, '../../..');
export const SOPS_ACTION = join(
  ACTUAL_UPSTREAM,
  '.github/actions/sops-secret/action.yml',
);

const NON_WHITESPACE = /\S/u;
const tmps: Array<string> = [];

export const mkTmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(dir);
  return dir;
};

export const cleanupTmpDirs = (): void => {
  while (tmps.length > 0) {
    const dir = tmps.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
};

export const write = (root: string, rel: string, content: string): void => {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
};

export const runProcess = (
  executable: string,
  cwd: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
): RunResult => {
  try {
    const stdout = execFileSync(executable, args, {
      cwd,
      encoding: 'utf8',
      env,
    });
    return { stdout, stderr: '', status: 0 };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      status: e.status ?? 1,
    };
  }
};

export const yamlStep = (path: string, stepName: string): string => {
  const lines = readFileSync(path, 'utf8').split('\n');
  const stepIndex = lines.findIndex(
    (line) => line.trim() === `- name: ${stepName}`,
  );
  if (stepIndex === -1) {
    throw new Error(`YAML step not found: ${stepName}`);
  }
  const stepIndent = (lines[stepIndex] ?? '').search(NON_WHITESPACE);
  const stepLines = [lines[stepIndex] ?? ''];
  for (let index = stepIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.length > 0 && line.search(NON_WHITESPACE) <= stepIndent) {
      break;
    }
    stepLines.push(line);
  }
  return stepLines.join('\n').trimEnd();
};

export const yamlRunScript = (path: string, stepName: string): string => {
  const lines = yamlStep(path, stepName).split('\n');
  const runIndex = lines.findIndex((line) => line.trim() === 'run: |');
  if (runIndex === -1) {
    throw new Error(`YAML run script not found: ${stepName}`);
  }
  const runIndent = (lines[runIndex] ?? '').search(NON_WHITESPACE);
  const scriptPrefix = ' '.repeat(runIndent + 2);
  const scriptLines: Array<string> = [];
  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.length > 0 && !line.startsWith(scriptPrefix)) {
      break;
    }
    scriptLines.push(
      line.startsWith(scriptPrefix) ? line.slice(scriptPrefix.length) : line,
    );
  }
  return scriptLines.join('\n').trimEnd();
};

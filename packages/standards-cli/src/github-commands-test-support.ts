import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HTTP_OK } from './github-api';

export const OPT_OUT_NOTICE =
  'standards github: rulesets are declared unenforceable on this GitHub plan (.github/settings.local.json "rulesetEnforcement"); the default branch is NOT protected, and plan-gated repository settings ("allow_auto_merge") are skipped. After upgrading the plan, remove the declaration, then run `bun standards github --apply`.';

// allow_auto_merge is plan-gated; delete_branch_on_merge is not, so the pair
// distinguishes plan-gated stripping from skipping repository settings.
const canonical = JSON.parse(
  '{"repository":{"allow_auto_merge":true,"delete_branch_on_merge":true},"rulesets":[{"name":"Protect main","target":"branch","enforcement":"active","rules":[]}]}',
) as unknown;

export const createConsumer = (
  options: { readonly optOut?: boolean; readonly origin?: boolean } = {},
): string => {
  const consumer = mkdtempSync(join(tmpdir(), 'github-commands-'));
  mkdirSync(join(consumer, '.github'));
  writeFileSync(
    join(consumer, '.github/settings.json'),
    JSON.stringify(canonical),
  );
  writeFileSync(
    join(consumer, '.github/settings.local.json'),
    JSON.stringify({
      repository: {},
      rulesets: [],
      ...(options.optOut === false
        ? {}
        : { rulesetEnforcement: 'unavailable-on-plan' }),
    }),
  );
  execFileSync('git', ['-C', consumer, 'init', '--quiet']);
  if (options.origin !== false) {
    execFileSync('git', [
      '-C',
      consumer,
      'remote',
      'add',
      'origin',
      'git@github.com:owner/repo.git',
    ]);
  }
  return consumer;
};

export type ApiCall = {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
};

export const liveRepository = (
  isPrivate: boolean,
  allowAutoMerge: boolean,
  deleteBranchOnMerge = true,
): Readonly<Record<string, unknown>> =>
  JSON.parse(
    `{"private":${String(isPrivate)},"allow_auto_merge":${String(allowAutoMerge)},"delete_branch_on_merge":${String(deleteBranchOnMerge)}}`,
  ) as Readonly<Record<string, unknown>>;

export const declaredPatchBody = (
  withPlanGated: boolean,
): Readonly<Record<string, unknown>> =>
  JSON.parse(
    withPlanGated
      ? '{"allow_auto_merge":true,"delete_branch_on_merge":true}'
      : '{"delete_branch_on_merge":true}',
  ) as Readonly<Record<string, unknown>>;

export const liveRulesetSummary = (): Readonly<Record<string, unknown>> =>
  JSON.parse(
    '{"id":7,"name":"Protect main","source_type":"Repository"}',
  ) as Readonly<Record<string, unknown>>;

type ApiResult = {
  readonly status?: number;
  readonly body: unknown;
};

export const installApi = (
  results: ReadonlyArray<ApiResult>,
): ReadonlyArray<ApiCall> => {
  const calls: Array<ApiCall> = [];
  const remaining = [...results];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const result = remaining.shift();
    if (result === undefined) {
      return Promise.reject(new Error('unexpected GitHub API request'));
    }
    const rawBody = typeof init?.body === 'string' ? init.body : null;
    calls.push({
      method: init?.method ?? 'GET',
      path: new URL(String(input)).pathname,
      body: rawBody === null ? null : (JSON.parse(rawBody) as unknown),
    });
    return Promise.resolve(
      new Response(result.body === null ? null : JSON.stringify(result.body), {
        status: result.status ?? HTTP_OK,
      }),
    );
  }) as typeof fetch;
  return calls;
};

export const installNetworkFailure = (): void => {
  globalThis.fetch = (() =>
    Promise.reject(new Error('offline'))) as unknown as typeof fetch;
};

export const captureConsole = (commandConsole: Console) => {
  const logs: Array<string> = [];
  const errors: Array<string> = [];
  const originalLog = commandConsole.log;
  const originalError = commandConsole.error;
  commandConsole.log = (...values) => {
    logs.push(values.join(' '));
  };
  commandConsole.error = (...values) => {
    errors.push(values.join(' '));
  };
  return {
    logs,
    errors,
    restore: () => {
      commandConsole.log = originalLog;
      commandConsole.error = originalError;
    },
  };
};

export const cleanup = (...paths: ReadonlyArray<string>): void => {
  for (const path of paths) {
    rmSync(path, { force: true, recursive: true });
  }
};

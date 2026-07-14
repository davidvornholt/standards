import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { runGithubApply, runGithubCheck } from './github-commands';

const originalFetch = globalThis.fetch;
const originalToken = process.env.GH_TOKEN;
const directories: Array<string> = [];
const EMPTY = { environments: [], repository: {}, rulesets: [] };
const TYPO_SETTING = 'allow_auto_merg';
const UNSUPPORTED_SETTING = 'has_wiki';
const KNOWN_HIDDEN_SETTING = 'delete_branch_on_merge';
const EXPECTED_READS = 2;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) {
    delete process.env.GH_TOKEN;
  } else {
    process.env.GH_TOKEN = originalToken;
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const consumerWith = (canonical: unknown, local: unknown): string => {
  const consumer = mkdtempSync(join(tmpdir(), 'github-repository-contract-'));
  directories.push(consumer);
  mkdirSync(join(consumer, '.github'));
  writeFileSync(
    join(consumer, '.github/settings.json'),
    JSON.stringify(canonical),
  );
  writeFileSync(
    join(consumer, '.github/settings.local.json'),
    JSON.stringify(local),
  );
  execFileSync('git', ['init', '--quiet', consumer]);
  execFileSync('git', [
    '-C',
    consumer,
    'remote',
    'add',
    'origin',
    'git@github.com:owner/repository.git',
  ]);
  return consumer;
};

const requestCount = async (
  command: (consumer: string) => Promise<boolean>,
  canonical: unknown,
  local: unknown,
) => {
  let requests = 0;
  globalThis.fetch = Object.assign(
    () => {
      requests += 1;
      return Promise.resolve(new Response(null, { status: 500 }));
    },
    { preconnect: originalFetch.preconnect },
  );
  process.env.GH_TOKEN = 'test-token';
  const result = await command(consumerWith(canonical, local));
  return { requests, result };
};

describe('repository settings request boundary', () => {
  it('rejects a typoed canonical key before check requests GitHub', async () => {
    const checked = await requestCount(
      runGithubCheck,
      { ...EMPTY, repository: { [TYPO_SETTING]: true } },
      EMPTY,
    );
    expect(checked).toEqual({ requests: 0, result: false });
  });

  it('rejects an unknown local key before apply requests GitHub', async () => {
    const applied = await requestCount(runGithubApply, EMPTY, {
      ...EMPTY,
      repository: { [UNSUPPORTED_SETTING]: false },
    });
    expect(applied).toEqual({ requests: 0, result: false });
  });

  it('keeps a known token-hidden setting unverifiable during check', async () => {
    let requests = 0;
    globalThis.fetch = Object.assign(
      (input: URL | RequestInfo) => {
        requests += 1;
        const body = String(input).includes('/rulesets?') ? [] : {};
        return Promise.resolve(
          new Response(JSON.stringify(body), { status: 200 }),
        );
      },
      { preconnect: originalFetch.preconnect },
    );
    process.env.GH_TOKEN = 'test-token';
    const consumer = consumerWith(
      { ...EMPTY, repository: { [KNOWN_HIDDEN_SETTING]: true } },
      EMPTY,
    );

    expect(await runGithubCheck(consumer)).toBe(true);
    expect(requests).toBe(EXPECTED_READS);
  });
});

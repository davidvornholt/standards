import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { runGithubApply } from './github-commands';
import { loadGithubSettings } from './github-settings';

const originalFetch = globalThis.fetch;
const originalToken = process.env.GH_TOKEN;
const directories: Array<string> = [];
const empty = { environments: [], repository: {}, rulesets: [] };
const DEFAULT_BRANCH = 'default_branch';
const DEFAULT_BRANCH_PROTECTION = 'default_branch_protection';
const REQUIRED_SIGNATURES = 'required_signatures';
const identityKeys: Array<string> = [
  'archived',
  'default_branch',
  'is_template',
  'name',
  'private',
  'visibility',
];

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) {
    delete process.env.GH_TOKEN;
  } else {
    process.env.GH_TOKEN = originalToken;
  }
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      rmSync(directory, { force: true, recursive: true });
    }
  }
});

const consumerWith = (canonical: unknown, local: unknown): string => {
  const consumer = mkdtempSync(join(tmpdir(), 'github-contract-'));
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
    'git@github.com:owner/repo.git',
  ]);
  return consumer;
};

const applyRequestCount = async (
  canonical: unknown,
  local: unknown,
): Promise<{ readonly requests: number; readonly result: boolean }> => {
  let requests = 0;
  globalThis.fetch = Object.assign(
    () => {
      requests += 1;
      return Promise.resolve(new Response(null, { status: 500 }));
    },
    { preconnect: originalFetch.preconnect },
  );
  process.env.GH_TOKEN = 'test-token';
  const result = await runGithubApply(consumerWith(canonical, local));
  return { requests, result };
};

describe('repository declaration boundary', () => {
  it.each(
    identityKeys,
  )('rejects reserved repository key %s in canonical and local declarations', (key) => {
    for (const [label, canonical, local] of [
      ['.github/settings.json', { repository: { [key]: true } }, empty],
      ['.github/settings.local.json', empty, { repository: { [key]: true } }],
    ] as const) {
      expect(
        loadGithubSettings(JSON.stringify(canonical), JSON.stringify(local))
          .problems,
      ).toContain(
        `${label} repository."${key}" cannot manage repository identity or lifecycle`,
      );
    }
  });

  it('rejects default-branch identity before any API request', async () => {
    const applied = await applyRequestCount(
      { ...empty, repository: { [DEFAULT_BRANCH]: 'trunk' } },
      empty,
    );
    expect(applied).toEqual({ requests: 0, result: false });
  });

  it('rejects local default-branch identity before any API request', async () => {
    const applied = await applyRequestCount(empty, {
      ...empty,
      repository: { [DEFAULT_BRANCH]: 'trunk' },
    });
    expect(applied).toEqual({ requests: 0, result: false });
  });
});

describe('required signatures declaration boundary', () => {
  it('rejects enabling signatures before any API request', async () => {
    const canonical = JSON.parse(
      readFileSync(
        join(import.meta.dir, '../../../.github/settings.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const protection = canonical[DEFAULT_BRANCH_PROTECTION] as Record<
      string,
      unknown
    >;
    protection[REQUIRED_SIGNATURES] = true;
    const applied = await applyRequestCount(canonical, empty);
    expect(applied).toEqual({ requests: 0, result: false });
  });
});

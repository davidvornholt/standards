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
import { invalidRepositoryValues } from './github-repository-value-test-fixture';
import { declaredRuleset } from './github-ruleset-test-fixture';
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
const validRuleset = declaredRuleset('Protect main');
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

  it.each(
    invalidRepositoryValues,
  )('rejects invalid canonical and local repository values for %s before requests', async (key, value) => {
    const declarations = [
      [{ ...empty, repository: { [key]: value } }, empty],
      [empty, { ...empty, repository: { [key]: value } }],
    ] as const;
    const results = await Promise.all(
      declarations.map(([canonical, local]) =>
        applyRequestCount(canonical, local),
      ),
    );
    expect(results).toEqual([
      { requests: 0, result: false },
      { requests: 0, result: false },
    ]);
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

describe('ruleset declaration boundary', () => {
  it.each([
    ['unknown top-level state', { ...validRuleset, ignored: true }],
    ['a non-record rule', { ...validRuleset, rules: ['deletion'] }],
    [
      'duplicate rule types',
      {
        ...validRuleset,
        rules: [{ type: 'deletion' }, { type: 'deletion' }],
      },
    ],
    [
      'malformed rule parameters',
      {
        ...validRuleset,
        rules: [{ parameters: {}, type: 'pull_request' }],
      },
    ],
    [
      'an excessive approving-review count',
      {
        ...validRuleset,
        rules: [
          JSON.parse(
            '{"type":"pull_request","parameters":{"required_approving_review_count":11,"dismiss_stale_reviews_on_push":true,"required_reviewers":[],"require_code_owner_review":false,"require_last_push_approval":false,"required_review_thread_resolution":true,"allowed_merge_methods":["squash"]}}',
          ) as unknown,
        ],
      },
    ],
  ] as const)('rejects %s before any API request', async (_label, ruleset) => {
    const applied = await applyRequestCount(
      { ...empty, rulesets: [ruleset] },
      empty,
    );
    expect(applied).toEqual({ requests: 0, result: false });
  });
});

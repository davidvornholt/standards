import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import process from 'node:process';
import { type ApiCall, installApi } from './github-commands-test-support';
import { applyLabels, diffLabels } from './github-labels';
import { loadGithubSettings } from './github-settings';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.GH_TOKEN = 'test-token';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.GH_TOKEN = undefined;
});

const declared = [
  { name: 'approved-for-fix', color: '0e8a16', description: 'Approve a fix' },
] as const;

describe('diffLabels', () => {
  it('matches live label identity without regard to case', () => {
    expect(
      diffLabels(declared, [{ ...declared[0], name: 'Approved-For-Fix' }]),
    ).toEqual([]);
  });

  it('reports a missing declared label', () => {
    expect(diffLabels(declared, [])).toEqual([
      'label "approved-for-fix" is declared but missing on GitHub',
    ]);
  });

  it('reports color and description drift, ignoring live case', () => {
    expect(
      diffLabels(declared, [
        {
          name: 'approved-for-fix',
          color: 'FBCA04',
          description: 'Approve a fix',
        },
      ]),
    ).toEqual([
      'label "approved-for-fix" has color "fbca04" on GitHub, declared "0e8a16"',
    ]);
    expect(
      diffLabels(declared, [
        { name: 'approved-for-fix', color: '0e8a16', description: 'other' },
      ]),
    ).toEqual([
      'label "approved-for-fix" has a different description on GitHub than declared',
    ]);
  });

  it('ignores undeclared live labels', () => {
    expect(
      diffLabels(declared, [
        {
          name: 'approved-for-fix',
          color: '0e8a16',
          description: 'Approve a fix',
        },
        { name: 'wontfix', color: 'ffffff', description: '' },
      ]),
    ).toEqual([]);
  });
});

describe('applyLabels', () => {
  it('updates a case-variant through its live display spelling', async () => {
    const calls = installApi([
      {
        body: [
          {
            ...declared[0],
            name: 'Approved-For-Fix',
            description: 'old',
          },
        ],
      },
      { body: {} },
    ]);
    expect(await applyLabels('token', 'o/r', declared)).toEqual([
      'updated label "approved-for-fix"',
    ]);
    expect(calls[1]?.path).toBe('/repos/o/r/labels/Approved-For-Fix');
  });

  it('creates missing labels and updates drifted ones', async () => {
    const calls: ReadonlyArray<ApiCall> = installApi([
      {
        body: [
          {
            name: 'fix-failed',
            color: '000000',
            description: 'Automated fix failed',
          },
        ],
      },
      { status: 201, body: {} },
      { body: {} },
    ]);
    const actions = await applyLabels('t', 'o/r', [
      ...declared,
      {
        name: 'fix-failed',
        color: 'd73a4a',
        description: 'Automated fix failed',
      },
    ]);
    expect(actions).toEqual([
      'created label "approved-for-fix"',
      'updated label "fix-failed"',
    ]);
    expect(
      calls
        .filter((call) => call.method !== 'GET')
        .map((call) => `${call.method} ${call.path}`),
    ).toEqual(['POST /repos/o/r/labels', 'PATCH /repos/o/r/labels/fix-failed']);
  });

  it('does nothing when no labels are declared', async () => {
    const calls: ReadonlyArray<ApiCall> = installApi([]);
    expect(await applyLabels('t', 'o/r', [])).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('declared label settings', () => {
  const local = '{"repository":{},"rulesets":[]}';

  it('accepts declared labels and merges local additions', () => {
    const { merged, problems } = loadGithubSettings(
      '{"repository":{},"rulesets":[],"labels":[{"name":"a","color":"0e8a16","description":"d"}]}',
      '{"repository":{},"rulesets":[],"labels":[{"name":"b","color":"1d76db","description":"e"}]}',
    );
    expect(problems).toEqual([]);
    expect(merged?.labels.map((label) => label.name)).toEqual(['a', 'b']);
  });

  it('rejects malformed label declarations', () => {
    const { merged, problems } = loadGithubSettings(
      '{"repository":{},"rulesets":[],"labels":[{"name":"a","color":"#0E8A16","description":"d"}]}',
      local,
    );
    expect(merged).toBeNull();
    expect(problems[0]).toContain('labels[0]');
  });

  it('rejects local labels that collide with canonical ones', () => {
    const { merged, problems } = loadGithubSettings(
      '{"repository":{},"rulesets":[],"labels":[{"name":"a","color":"0e8a16","description":"d"}]}',
      '{"repository":{},"rulesets":[],"labels":[{"name":"a","color":"ffffff","description":"mine"}]}',
    );
    expect(merged).toBeNull();
    expect(problems).toEqual([
      '.github/settings.local.json label "a" collides with a canonical label; canonical labels are read-only',
    ]);
  });

  it('rejects case-variant canonical collisions', () => {
    const { problems } = loadGithubSettings(
      '{"repository":{},"rulesets":[],"labels":[{"name":"Needs-Clarification","color":"0e8a16","description":"d"}]}',
      '{"repository":{},"rulesets":[],"labels":[{"name":"needs-clarification","color":"ffffff","description":"mine"}]}',
    );
    expect(problems[0]).toContain('collides with a canonical label');
  });

  it('rejects duplicate labels within one file', () => {
    const { problems } = loadGithubSettings(
      '{"repository":{},"rulesets":[],"labels":[{"name":"a","color":"0e8a16","description":"d"},{"name":"a","color":"0e8a16","description":"d"}]}',
      local,
    );
    expect(problems).toEqual([
      '.github/settings.json declares label "a" more than once',
    ]);
  });

  it('rejects case-variant duplicates within one file', () => {
    const { problems } = loadGithubSettings(
      '{"repository":{},"rulesets":[],"labels":[{"name":"A","color":"0e8a16","description":"d"},{"name":"a","color":"0e8a16","description":"d"}]}',
      '{"repository":{},"rulesets":[],"labels":[]}',
    );
    expect(problems).toEqual([
      '.github/settings.json declares label "a" more than once',
    ]);
  });
});

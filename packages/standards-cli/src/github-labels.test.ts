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
  delete process.env.GH_TOKEN;
});

const declared = [
  { name: 'triaged', color: '0e8a16', description: 'Ready for implementation' },
] as const;

describe('diffLabels', () => {
  it('matches live label identity without regard to case', () => {
    expect(diffLabels(declared, [{ ...declared[0], name: 'Triaged' }])).toEqual(
      [],
    );
  });

  it('reports a missing declared label', () => {
    expect(diffLabels(declared, [])).toEqual([
      'label "triaged" is declared but missing on GitHub',
    ]);
  });

  it('reports color and description drift, ignoring live case', () => {
    expect(
      diffLabels(declared, [
        {
          name: 'triaged',
          color: 'FBCA04',
          description: 'Ready for implementation',
        },
      ]),
    ).toEqual([
      'label "triaged" has color "fbca04" on GitHub, declared "0e8a16"',
    ]);
    expect(
      diffLabels(declared, [
        { name: 'triaged', color: '0e8a16', description: 'other' },
      ]),
    ).toEqual([
      'label "triaged" has a different description on GitHub than declared',
    ]);
  });

  it('ignores undeclared live labels', () => {
    expect(
      diffLabels(declared, [
        {
          name: 'triaged',
          color: '0e8a16',
          description: 'Ready for implementation',
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
            name: 'Triaged',
            description: 'old',
          },
        ],
      },
      { body: {} },
    ]);
    expect(await applyLabels('token', 'o/r', declared)).toEqual([
      'updated label "triaged"',
    ]);
    expect(calls[1]?.path).toBe('/repos/o/r/labels/Triaged');
  });

  it('creates missing labels and updates drifted ones', async () => {
    const calls: ReadonlyArray<ApiCall> = installApi([
      {
        body: [
          {
            name: 'blocked',
            color: '000000',
            description: 'Waiting on a dependency',
          },
        ],
      },
      { status: 201, body: {} },
      { body: {} },
    ]);
    const actions = await applyLabels('t', 'o/r', [
      ...declared,
      {
        name: 'blocked',
        color: 'd73a4a',
        description: 'Waiting on a dependency',
      },
    ]);
    expect(actions).toEqual([
      'created label "triaged"',
      'updated label "blocked"',
    ]);
    expect(
      calls
        .filter((call) => call.method !== 'GET')
        .map((call) => `${call.method} ${call.path}`),
    ).toEqual(['POST /repos/o/r/labels', 'PATCH /repos/o/r/labels/blocked']);
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

  it('rejects case-variant canonical collisions', () => {
    const { merged, problems } = loadGithubSettings(
      '{"repository":{},"rulesets":[],"labels":[{"name":"Canonical-Label","color":"0e8a16","description":"d"}]}',
      '{"repository":{},"rulesets":[],"labels":[{"name":"canonical-label","color":"ffffff","description":"mine"}]}',
    );
    expect(merged).toBeNull();
    expect(problems).toEqual([
      '.github/settings.local.json label "canonical-label" collides with a canonical label; canonical labels are read-only',
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

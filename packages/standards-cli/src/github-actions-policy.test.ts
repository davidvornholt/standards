import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import process from 'node:process';
import {
  AUTO_MERGE_POLICY,
  AUTO_MERGE_WORKFLOW_PATH,
  diffActionsPolicies,
  POLICY_NOT_VISIBLE_NOTICE,
} from './github-actions-policy';
import { HTTP_CREATED, HTTP_FORBIDDEN } from './github-api';
import { runGithubApply, runGithubCheck } from './github-commands';
import {
  captureConsole,
  cleanup,
  createConsumer,
  installApi,
  liveRepository,
  liveRulesetConditions,
  liveRulesetSummary,
} from './github-commands-test-support';
import { BYPASS_ACTORS_KEY } from './github-settings-parse';
import { restoreProcessEnv } from './process-env-test-support';

const originalFetch = globalThis.fetch;
const originalGhToken = process.env.GH_TOKEN;
const originalGithubToken = process.env.GITHUB_TOKEN;
const originalGithubActions = process.env.GITHUB_ACTIONS;
const commandConsole = Reflect.get(globalThis, 'console') as Console;
const temporaryPaths: Array<string> = [];
let output = captureConsole(commandConsole);

beforeEach(() => {
  output.restore();
  output = captureConsole(commandConsole);
  process.env.GH_TOKEN = 'test-token';
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_ACTIONS;
});

afterEach(() => {
  output.restore();
  cleanup(...temporaryPaths.splice(0));
  globalThis.fetch = originalFetch;
  restoreProcessEnv('GH_TOKEN', originalGhToken);
  restoreProcessEnv('GITHUB_TOKEN', originalGithubToken);
  restoreProcessEnv('GITHUB_ACTIONS', originalGithubActions);
});

const consumer = (): string => {
  const path = createConsumer({ optOut: false });
  temporaryPaths.push(path);
  return path;
};

const policy = (
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> => ({
  ...AUTO_MERGE_POLICY,
  id: 3,
  source_type: 'Repository',
  source: 'owner/repo',
  ...overrides,
});

const eventRule = (events: ReadonlyArray<string>) => [
  { type: 'restrict_action_events', parameters: { allowed_events: events } },
];

const workflowPaths = (
  include: ReadonlyArray<string>,
  exclude: ReadonlyArray<string> = [],
) => ({ workflow_path: { include, exclude } });

// Repository read and an unchanged ruleset, the calls before the policy check.
const convergedRepository = [
  { body: liveRepository(false, true) },
  { body: [liveRulesetSummary()] },
  {
    body: {
      enforcement: 'active',
      id: 7,
      name: 'Protect main',
      conditions: liveRulesetConditions,
      [BYPASS_ACTORS_KEY]: [],
      rules: [],
      target: 'branch',
    },
  },
];

const listed = (policies: ReadonlyArray<Readonly<Record<string, unknown>>>) => [
  {
    body: {
      total_count: policies.length,
      policies: policies.map(({ conditions: _c, rules: _r, ...summary }) => ({
        ...summary,
        _links: {
          self: {
            href:
              summary.source_type === 'Repository'
                ? `https://api.github.com/repos/owner/repo/actions/policies/${String(summary.id)}`
                : `https://api.github.com/orgs/owner/actions/policies/${String(summary.id)}`,
          },
        },
      })),
    },
  },
  ...policies.map((body) => ({ body })),
];

describe('diffActionsPolicies', () => {
  it('accepts the standard policy', () => {
    expect(diffActionsPolicies([policy()])).toEqual([]);
  });

  it('accepts a broader policy that allows both events', () => {
    expect(
      diffActionsPolicies([
        policy({
          conditions: workflowPaths(['.github/workflows/*.yml']),
          rules: eventRule(['pull_request', 'pull_request_target', 'push']),
        }),
      ]),
    ).toEqual([]);
    expect(
      diffActionsPolicies([
        policy({
          conditions: {},
          rules: eventRule(['pull_request_target', 'push']),
        }),
      ]),
    ).toEqual([]);
  });

  it('requires an active policy with an event rule for the workflow', () => {
    for (const policies of [
      [],
      [policy({ enforcement: 'evaluate' })],
      [policy({ enforcement: 'disabled' })],
      [policy({ conditions: workflowPaths(['.github/workflows/ci.yml']) })],
      [
        policy({
          conditions: workflowPaths(['~ALL'], [AUTO_MERGE_WORKFLOW_PATH]),
        }),
      ],
      [policy({ rules: [] })],
    ]) {
      expect(diffActionsPolicies(policies)).toEqual([
        `no active Actions event policy allows pull_request_target and push for ${AUTO_MERGE_WORKFLOW_PATH}; GitHub blocks pull_request_target in public repositories without one, so bot pull requests stop merging on their own`,
      ]);
    }
  });

  it('names a matching policy that leaves out an event the workflow needs', () => {
    expect(
      diffActionsPolicies([
        policy(),
        policy({
          name: 'Org events',
          source_type: 'Organization',
          source: 'owner',
          conditions: workflowPaths(['~ALL']),
          rules: eventRule(['pull_request_target']),
        }),
      ]),
    ).toEqual([
      `Actions policy "Org events" from owner applies to ${AUTO_MERGE_WORKFLOW_PATH} but doesn't allow push, so Standards auto-merge can't run on those events`,
    ]);
  });
});

describe('github --check in a public repository', () => {
  it('reads each policy and passes on the standard one', async () => {
    const calls = installApi([...convergedRepository, ...listed([policy()])]);

    expect(await runGithubCheck(consumer())).toBe(true);
    expect(
      calls.slice(-2).map(({ method, path }) => ({ method, path })),
    ).toEqual([
      { method: 'GET', path: '/repos/owner/repo/actions/policies' },
      { method: 'GET', path: '/repos/owner/repo/actions/policies/3' },
    ]);
    expect(output.errors).toEqual([]);
  });

  it('fails without a policy', async () => {
    installApi([...convergedRepository, ...listed([])]);

    expect(await runGithubCheck(consumer())).toBe(false);
    expect(output.errors.join('\n')).toContain(
      'no active Actions event policy allows pull_request_target and push',
    );
  });

  it('reads an inherited policy through the repository path', async () => {
    const inherited = policy({
      id: 9,
      name: 'Org events',
      source_type: 'Organization',
      source: 'owner',
    });
    const calls = installApi([...convergedRepository, ...listed([inherited])]);

    expect(await runGithubCheck(consumer())).toBe(true);
    expect(calls.at(-1)?.path).toBe('/repos/owner/repo/actions/policies/9');
  });

  const denied = {
    status: HTTP_FORBIDDEN,
    body: { message: 'Resource not accessible by integration' },
  };

  it.each([
    ['the list', [denied]],
    ['a policy', [...listed([policy()]).slice(0, 1), denied]],
  ])(
    'fails closed outside GitHub Actions when the token cannot read %s',
    async (_what, responses) => {
      installApi([...convergedRepository, ...responses]);

      expect(await runGithubCheck(consumer())).toBe(false);
      expect(output.errors.join('\n')).toContain(
        'HTTP 403 Resource not accessible by integration; reading them needs repository Administration write',
      );
    },
  );

  it('passes with a notice in GitHub Actions when the token cannot read policies', async () => {
    process.env.GITHUB_ACTIONS = 'true';
    installApi([...convergedRepository, denied]);

    expect(await runGithubCheck(consumer())).toBe(true);
    expect(output.logs[0]).toContain(
      'run `bash .agents/skills/standards-sync/scripts/standards.sh github --check` locally',
    );
    expect(output.logs).toEqual([
      POLICY_NOT_VISIBLE_NOTICE,
      'standards github: live GitHub settings match the declared configuration',
    ]);
  });
});

describe('github --apply in a public repository', () => {
  it('creates the standard policy when none allows the workflow', async () => {
    const calls = installApi([
      ...convergedRepository,
      ...listed([]),
      { status: HTTP_CREATED, body: policy() },
    ]);

    expect(await runGithubApply(consumer())).toBe(true);
    expect(calls.at(-1)).toEqual({
      method: 'POST',
      path: '/repos/owner/repo/actions/policies',
      search: '',
      body: AUTO_MERGE_POLICY,
    });
    expect(output.logs).toContain(
      '  created Actions policy "Standards auto-merge events"',
    );
  });

  it('changes nothing when a policy already allows the workflow', async () => {
    const calls = installApi([...convergedRepository, ...listed([policy()])]);

    expect(await runGithubApply(consumer())).toBe(true);
    expect(calls.every(({ method }) => method === 'GET')).toBe(true);
    expect(output.logs.at(-1)).toBe(
      'standards github: already converged; no changes',
    );
  });

  it('leaves its own policy alone when an inherited policy conflicts', async () => {
    const actorRule = {
      type: 'restrict_actions_actors',
      parameters: { allowed_actors: [{ id: 1, type: 'User' }] },
    };
    const calls = installApi([
      ...convergedRepository,
      ...listed([
        policy({
          rules: [...eventRule(['pull_request_target', 'push']), actorRule],
        }),
        policy({
          id: 9,
          name: 'Org events',
          source_type: 'Organization',
          source: 'owner',
          conditions: workflowPaths(['~ALL']),
          rules: eventRule(['push']),
        }),
      ]),
    ]);

    expect(await runGithubApply(consumer())).toBe(false);
    expect(calls.every(({ method }) => method === 'GET')).toBe(true);
    expect(output.errors.join('\n')).toContain(
      'cannot converge Actions policy "Standards auto-merge events": Actions policy "Org events" from owner applies',
    );
  });

  it('fails when the token cannot read policies', async () => {
    installApi([...convergedRepository, { status: HTTP_FORBIDDEN, body: {} }]);

    expect(await runGithubApply(consumer())).toBe(false);
    expect(output.errors.join('\n')).toContain(
      'listing Actions policies: HTTP 403 unexpected response; reading them needs repository Administration write',
    );
  });
});

describe('github --apply repairing its own policy', () => {
  it('rewrites its own policy when it has drifted', async () => {
    const calls = installApi([
      ...convergedRepository,
      ...listed([policy({ rules: eventRule(['pull_request_target']) })]),
      { body: policy() },
    ]);

    expect(await runGithubApply(consumer())).toBe(true);
    expect(calls.at(-1)).toEqual({
      method: 'PUT',
      path: '/repos/owner/repo/actions/policies/3',
      search: '',
      body: AUTO_MERGE_POLICY,
    });
  });

  it('keeps the rules and events it does not change when it repairs its own policy', async () => {
    const actorRule = {
      type: 'restrict_actions_actors',
      parameters: { allowed_actors: [{ id: 42, type: 'User' }] },
    };
    const calls = installApi([
      ...convergedRepository,
      ...listed([
        policy({
          conditions: workflowPaths(
            [AUTO_MERGE_WORKFLOW_PATH],
            ['.github/workflows/*-merge.yml'],
          ),
          rules: [actorRule, ...eventRule(['push', 'workflow_dispatch'])],
        }),
      ]),
      { body: policy() },
    ]);

    expect(await runGithubApply(consumer())).toBe(true);
    expect(calls.at(-1)).toEqual({
      method: 'PUT',
      path: '/repos/owner/repo/actions/policies/3',
      search: '',
      body: {
        ...AUTO_MERGE_POLICY,
        rules: [
          actorRule,
          ...eventRule(['push', 'workflow_dispatch', 'pull_request_target']),
        ],
      },
    });
  });

  it.each([
    [
      'another workflow',
      [AUTO_MERGE_WORKFLOW_PATH, '.github/workflows/release.yml'],
    ],
    ['a glob', ['.github/workflows/*.yml']],
    ['every workflow', []],
  ])(
    'leaves its own policy alone when it also covers %s',
    async (_what, include) => {
      const calls = installApi([
        ...convergedRepository,
        ...listed([
          policy({
            conditions: workflowPaths(include),
            rules: eventRule(['push']),
          }),
        ]),
      ]);

      expect(await runGithubApply(consumer())).toBe(false);
      expect(calls.every(({ method }) => method === 'GET')).toBe(true);
      expect(output.errors.join('\n')).toContain(
        `cannot repair Actions policy "Standards auto-merge events": it also applies to workflows other than ${AUTO_MERGE_WORKFLOW_PATH}`,
      );
    },
  );
});

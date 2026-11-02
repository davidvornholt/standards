import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ACTUAL_UPSTREAM } from './cli-test-support';
import { expression } from './standards-sync-broker-workflow-contract';

type Step = Readonly<Record<string, unknown>> & {
  readonly id?: string;
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
};
type Job = Readonly<Record<string, unknown>> & {
  readonly steps: ReadonlyArray<Step>;
};
type Workflow = {
  readonly on: unknown;
  readonly permissions: unknown;
  readonly jobs: Readonly<Record<string, Job>>;
};

const WORKFLOW_PATH = join(
  ACTUAL_UPSTREAM,
  '.github/workflows/standards-auto-merge.yml',
);
const source = readFileSync(WORKFLOW_PATH, 'utf8');
const workflow = parseYaml(source) as Workflow;
const job = (name: string): Job => {
  const found = workflow.jobs[name];
  if (found === undefined) {
    throw new Error(`Missing Standards auto-merge job: ${name}`);
  }
  return found;
};
const step = (jobName: string, name: string): Step => {
  const found = job(jobName).steps.filter(
    (candidate) => candidate.name === name,
  );
  if (found.length !== 1 || found[0] === undefined) {
    throw new Error(`Expected exactly one ${jobName} step: ${name}`);
  }
  return found[0];
};

const TRUSTED_CHECKOUT = {
  name: 'Checkout trusted secret inputs',
  uses: 'actions/checkout@v7',
  with: {
    'persist-credentials': false,
    'sparse-checkout': '.github/actions/sops-secret\nsecrets/ci.yaml\n',
    'sparse-checkout-cone-mode': false,
  },
};
const resolved = (name: string, id: string, key: string): Step => ({
  name,
  id,
  uses: './.github/actions/sops-secret',
  with: {
    'age-key': expression('secrets.SOPS_AGE_KEY'),
    'secret-file': 'secrets/ci.yaml',
    'secret-key': key,
  },
});
const minted = (
  name: string,
  id: string,
  permissions: Readonly<Record<string, string>>,
): Step => ({
  name,
  id,
  uses: 'actions/create-github-app-token@v3',
  with: {
    'client-id': expression('steps.broker-app-client-id.outputs.value'),
    'private-key': expression('steps.broker-app-private-key.outputs.value'),
    ...permissions,
  },
});
const brokerSteps = (mint: Step): Array<Step> => [
  TRUSTED_CHECKOUT,
  resolved(
    'Resolve broker App client ID',
    'broker-app-client-id',
    'broker_app.client_id',
  ),
  resolved(
    'Resolve broker App private key',
    'broker-app-private-key',
    'broker_app.private_key',
  ),
  mint,
];
// Matching the bare step id also catches bracket and spacing variants.
const readersOf = (jobName: string, producerId: string): Array<string> =>
  job(jobName)
    .steps.filter(
      (candidate) =>
        candidate.id !== producerId &&
        JSON.stringify(candidate).includes(producerId),
    )
    .map((candidate) => candidate.name ?? '');

describe('Standards auto-merge workflow contract', () => {
  it('runs on Dependabot pull request events and main pushes with a read-only default token', () => {
    expect(workflow.on).toEqual({
      // biome-ignore lint/style/useNamingConvention: GitHub names this event in snake_case.
      pull_request_target: { types: ['opened', 'reopened', 'synchronize'] },
      push: { branches: ['main'] },
    });
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(workflow.jobs)).toEqual([
      'dependabot',
      'sync',
      'pending',
      'update',
    ]);
  });

  it('decides only for same-repository Dependabot pull requests to the default branch', () => {
    const dependabot = job('dependabot');
    expect(dependabot.if).toBe(
      [
        "github.event_name == 'pull_request_target'",
        "github.event.pull_request.user.login == 'dependabot[bot]'",
        'github.event.pull_request.head.repo.full_name == github.repository',
        'github.event.pull_request.base.ref == github.event.repository.default_branch',
        "(github.event.action != 'synchronize' || github.event.sender.login == 'dependabot[bot]' || github.event.sender.type != 'Bot')",
      ].join(' && '),
    );
    expect(dependabot.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read',
    });
    expect(dependabot.steps.slice(0, 4)).toEqual(
      brokerSteps(
        minted('Mint current-repository merge token', 'merge-token', {
          'permission-contents': 'write',
          'permission-pull-requests': 'write',
          'permission-workflows': 'write',
        }),
      ),
    );
    // The metadata action reads the pull request with the job token only.
    expect(step('dependabot', 'Read Dependabot update metadata')).toEqual({
      name: 'Read Dependabot update metadata',
      id: 'metadata',
      if: "github.event.action != 'synchronize' || github.event.sender.login == 'dependabot[bot]'",
      uses: 'dependabot/fetch-metadata@v3',
    });
    expect(dependabot.steps).toHaveLength(6);
    expect(readersOf('dependabot', 'merge-token')).toEqual([
      'Apply the auto-merge decision',
    ]);
  });

  it('updates branches only from a trusted push with a branch updater token', () => {
    const pending = job('pending');
    expect(pending.if).toBe("github.event_name == 'push'");
    expect(pending.environment).toBeUndefined();
    expect(JSON.stringify(pending)).not.toContain('secrets.');
    expect(pending.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read',
    });

    const update = job('update');
    expect(update.needs).toBe('pending');
    expect(update.if).toBe("needs.pending.outputs.pull-requests != '[]'");
    expect(update.permissions).toEqual({ contents: 'read' });
    expect(update.steps.slice(0, 4)).toEqual(
      brokerSteps(
        minted(
          'Mint current-repository branch updater token',
          'updater-token',
          {
            'permission-contents': 'write',
            'permission-workflows': 'write',
          },
        ),
      ),
    );
    expect(update.steps).toHaveLength(5);
    expect(readersOf('update', 'updater-token')).toEqual([
      'Merge main into pull requests waiting to auto-merge',
    ]);
  });

  it('passes App credentials only to mint steps and event data only through env', () => {
    for (const jobName of ['dependabot', 'sync', 'update']) {
      const mint = job(jobName).steps[3]?.name ?? '';
      for (const producer of [
        'broker-app-client-id',
        'broker-app-private-key',
      ]) {
        expect(readersOf(jobName, producer)).toEqual([mint]);
      }
    }
    // No run script expands an expression, so pull request titles, branch
    // names, and logins can never become shell code.
    for (const { steps } of Object.values(workflow.jobs)) {
      for (const { run } of steps) {
        expect(run ?? '').not.toContain(['$', '{{'].join(''));
      }
    }
    // No step checks out anything but the trusted default-branch files.
    const checkouts = Object.values(workflow.jobs).flatMap(({ steps }) =>
      steps.filter(({ uses }) => uses?.startsWith('actions/checkout') === true),
    );
    expect(checkouts).toEqual([
      TRUSTED_CHECKOUT,
      TRUSTED_CHECKOUT,
      TRUSTED_CHECKOUT,
    ]);
  });
});

describe('Standards sync auto-merge revocation contract', () => {
  it('revokes sync auto-merge after every push to the same-repository sync branch', () => {
    const sync = job('sync');
    expect(sync.if).toBe(
      [
        "github.event_name == 'pull_request_target'",
        "github.event.action == 'synchronize'",
        'github.event.pull_request.head.repo.full_name == github.repository',
        "github.event.pull_request.head.ref == 'standards-sync/update'",
      ].join(' && '),
    );
    // A cancelled run could leave a person's commits set to auto-merge.
    expect(sync.concurrency).toBeUndefined();
    expect(sync.permissions).toEqual({ contents: 'read' });
    expect(sync.steps.slice(0, 4)).toEqual(
      brokerSteps(
        minted('Mint current-repository auto-merge token', 'auto-merge-token', {
          'permission-contents': 'write',
          'permission-pull-requests': 'write',
        }),
      ),
    );
    expect(sync.steps).toHaveLength(5);
    expect(readersOf('sync', 'auto-merge-token')).toEqual([
      'Turn sync auto-merge off after a push by anyone else',
    ]);
  });
});

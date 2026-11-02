import { describe, expect, it } from 'bun:test';
import {
  assertSecuritySensitiveSteps,
  clientIdOutput,
  expression,
  type MutableWorkflow,
  mergeMintName,
  mergeToken,
  namedStep,
  parsedWorkflow,
  privateKeyOutput,
  prMintName,
  prToken,
  resolveClientIdName,
  syncName,
  syncPolicyRefName,
  type TokenConsumerContracts,
  workflowSource,
  writerMintName,
  writerToken,
} from './standards-sync-broker-workflow-contract';

const compactExpression = (value: string): string =>
  ['$', '{{', value, '}}'].join('');
const writerTokenName = ['BRANCH', 'WRITER', 'TOKEN'].join('_');
const prTokenName = ['GH', 'TOKEN'].join('_');
const consumerContracts: TokenConsumerContracts = {
  writer: {
    name: 'Commit and push mirror changes',
    id: 'sync-branch',
    if: "steps.mirror.outputs.changed == 'true'",
    env: {
      [writerTokenName]: writerToken,
      [['EXPECTED', 'SYNC', 'HEAD'].join('_')]: expression(
        'steps.sync-base.outputs.previous',
      ),
    },
    run: `git() { command git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c commit.gpgsign=false "$@"; }
branch=standards-sync/update
git config --local credential.helper "!f() { echo username=x-access-token; echo \\"password=\\$BRANCH_WRITER_TOKEN\\"; }; f"
trap 'git config --unset credential.helper' EXIT
git add -A
if ! git diff --cached --quiet; then
  git commit -m "chore: sync standards from upstream"
fi
git push --force-with-lease="refs/heads/$branch:$EXPECTED_SYNC_HEAD" --set-upstream origin "$branch"
echo "branch=$branch" >> "$GITHUB_OUTPUT"
`,
  },
  pullRequest: {
    name: 'Reconcile sync pull requests',
    id: 'reconcile',
    env: {
      [prTokenName]: prToken,
      [['MIRROR', 'CHANGED'].join('_')]: expression(
        'steps.mirror.outputs.changed',
      ),
    },
    run: `open=$(gh pr list --state open --limit 1000 --json number,headRefName,isCrossRepository --jq '[.[] | select((.isCrossRepository | not) and (.headRefName | startswith("standards-sync/")))]')
current=
if [ "$MIRROR_CHANGED" = true ]; then
  current=$(jq -r '[.[] | select(.headRefName == "standards-sync/update")][0].number // empty' <<<"$open")
  if [ -n "$current" ]; then
    gh pr edit "$current" --body-file "$RUNNER_TEMP/standards-sync-pr-body.md"
    echo "Updated existing standards sync PR #$current"
  else
    url=$(gh pr create \\
      --head "${expression('steps.sync-branch.outputs.branch')}" \\
      --title "chore: sync standards from upstream" \\
      --body-file "$RUNNER_TEMP/standards-sync-pr-body.md")
    current=\${url##*/}
  fi
  comment="Superseded by #$current, the current standards sync pull request."
else
  comment="Closed because the base branch already matches the upstream standards."
fi
superseded=$(jq -r --arg current "$current" '.[] | select((.number | tostring) != $current) | .number' <<<"$open")
for number in $superseded; do
  gh pr close "$number" --comment "$comment"
  echo "Closed superseded standards sync PR #$number"
done
echo "number=$current" >> "$GITHUB_OUTPUT"
`,
  },
  autoMerge: {
    name: 'Enable sync pull request auto-merge',
    if: "steps.mirror.outputs.changed == 'true'",
    env: {
      [prTokenName]: mergeToken,
      [['SYNC', 'PR'].join('_')]: expression('steps.reconcile.outputs.number'),
    },
    run: `set -euo pipefail
if [[ ! "$SYNC_PR" =~ ^[0-9]+$ ]]; then
  echo "::error::Reconcile sync pull requests reported no current pull request"
  exit 1
fi
enabled=$(gh pr view "$SYNC_PR" --json autoMergeRequest --jq '.autoMergeRequest != null')
if [ "$enabled" = true ]; then
  echo "Auto-merge is already enabled for standards sync PR #$SYNC_PR"
else
  gh pr merge "$SYNC_PR" --auto --squash
  echo "Enabled auto-merge for standards sync PR #$SYNC_PR"
fi
`,
  },
};

const mutableStep = (
  workflow: MutableWorkflow,
  name: string,
): Record<string, unknown> =>
  namedStep(workflow, name) as Record<string, unknown>;
const rejectsMutation = (
  mutate: (workflow: MutableWorkflow) => void,
): boolean => {
  const workflow = structuredClone(parsedWorkflow) as MutableWorkflow;
  mutate(workflow);
  try {
    assertSecuritySensitiveSteps(workflow, consumerContracts);
    return false;
  } catch {
    return true;
  }
};
const moveStepAfterSync = (workflow: MutableWorkflow, name: string): void => {
  const { steps } = workflow.jobs.sync;
  const selectedIndex = steps.findIndex((step) => step.name === name);
  const [selectedStep] = steps.splice(selectedIndex, 1);
  const syncIndex = steps.findIndex((candidate) => candidate.name === syncName);
  steps.splice(syncIndex + 1, 0, selectedStep);
};
const addTokenConsumer =
  (tokenReference: string) =>
  (workflow: MutableWorkflow): void => {
    workflow.jobs.sync.steps.push({
      name: 'Consume broker token again',
      env: { leakedToken: tokenReference },
      run: 'true',
    });
  };
const dropMintInput =
  (mintName: string, input: string) =>
  (workflow: MutableWorkflow): void => {
    Reflect.deleteProperty(
      mutableStep(workflow, mintName).with as Record<string, string>,
      input,
    );
  };
const insertBeforeWriterMint = (
  workflow: MutableWorkflow,
  step: MutableWorkflow['jobs']['sync']['steps'][number],
): void => {
  const writerIndex = workflow.jobs.sync.steps.findIndex(
    (candidate) => candidate.name === writerMintName,
  );
  workflow.jobs.sync.steps.splice(writerIndex, 0, step);
};

// Each mutation softens one guarantee that the contract must reject.
const credentialMutations = (): ReadonlyArray<
  (workflow: MutableWorkflow) => void
> => {
  const sensitiveNames = [
    resolveClientIdName,
    writerMintName,
    prMintName,
    mergeMintName,
    'Commit and push mirror changes',
    'Reconcile sync pull requests',
    'Enable sync pull request auto-merge',
  ];
  const mutations: Array<(workflow: MutableWorkflow) => void> =
    sensitiveNames.map((name) => (workflow) => {
      mutableStep(workflow, name)['continue-on-error'] = true;
    });
  mutations.push(
    (workflow) => {
      Reflect.deleteProperty(mutableStep(workflow, writerMintName), 'id');
    },
    (workflow) => {
      mutableStep(workflow, prMintName).id = 'changed';
    },
    (workflow) => {
      mutableStep(workflow, mergeMintName).id = 'changed';
    },
    (workflow) => moveStepAfterSync(workflow, writerMintName),
    (workflow) => moveStepAfterSync(workflow, prMintName),
    (workflow) => moveStepAfterSync(workflow, mergeMintName),
    addTokenConsumer(writerToken),
    addTokenConsumer(prToken),
    addTokenConsumer(mergeToken),
    addTokenConsumer(compactExpression('steps.merge-token.outputs.token')),
    (workflow) => {
      // The PR token cannot merge, and the merge token must not edit PRs.
      mutableStep(workflow, 'Reconcile sync pull requests').env = {
        [prTokenName]: mergeToken,
        [['MIRROR', 'CHANGED'].join('_')]: expression(
          'steps.mirror.outputs.changed',
        ),
      };
    },
    (workflow) => {
      const inputs = mutableStep(workflow, mergeMintName).with as Record<
        string,
        string
      >;
      inputs['permission-administration'] = 'write';
    },
    addTokenConsumer(
      compactExpression('steps.branch-writer-token.outputs.token'),
    ),
    addTokenConsumer(
      expression("steps['branch-writer-token'].outputs['token']"),
    ),
    addTokenConsumer(compactExpression('steps.pr-token.outputs.token')),
    addTokenConsumer(expression("steps['pr-token'].outputs['token']")),
    addTokenConsumer(clientIdOutput),
    addTokenConsumer(privateKeyOutput),
    addTokenConsumer(
      compactExpression('steps.broker-app-private-key.outputs.value'),
    ),
    addTokenConsumer(
      expression("steps['broker-app-private-key'].outputs['value']"),
    ),
    (workflow) => {
      mutableStep(workflow, syncName).env = {
        [syncPolicyRefName]: expression('needs.policy.outputs.ref'),
        leakedKey: privateKeyOutput,
      };
    },
    (workflow) => {
      const resolver = mutableStep(workflow, resolveClientIdName);
      resolver.with = {
        ...(resolver.with as Record<string, string>),
        'env-name': 'BROKER_APP_CLIENT_ID',
      };
    },
    (workflow) =>
      insertBeforeWriterMint(workflow, {
        name: 'Run an action between resolving and minting',
        uses: 'example/action@v1',
      }),
    (workflow) => moveStepAfterSync(workflow, resolveClientIdName),
    (workflow) => {
      mutableStep(workflow, resolveClientIdName).if = 'always()';
    },
    dropMintInput(writerMintName, 'client-id'),
    dropMintInput(prMintName, 'client-id'),
    dropMintInput(mergeMintName, 'client-id'),
    dropMintInput(mergeMintName, 'permission-workflows'),
  );
  // The deprecated App ID input must not return as a second identity.
  for (const name of [writerMintName, prMintName, mergeMintName]) {
    mutations.push((workflow) => {
      const inputs = mutableStep(workflow, name).with as Record<string, string>;
      inputs['app-id'] = expression('steps.broker-app-id.outputs.value');
    });
  }
  return mutations;
};

describe('Standards sync broker credential contract', () => {
  it('pins exact fail-closed mappings, token isolation, and ordering', () => {
    assertSecuritySensitiveSteps(parsedWorkflow, consumerContracts);
    expect(parsedWorkflow.permissions).toEqual({ contents: 'read' });
    // The job token only fetches and checks for an open sync PR; every write
    // goes through a broker App token.
    expect(parsedWorkflow.jobs.sync.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read',
    });
    expect(
      namedStep(parsedWorkflow, 'Checkout').with?.['persist-credentials'],
    ).toBe(false);
    expect(namedStep(parsedWorkflow, syncName).env).toEqual({
      [syncPolicyRefName]: expression('needs.policy.outputs.ref'),
    });
    expect(
      workflowSource.match(/steps\.sync-branch\.outputs\.branch/gu) ?? [],
    ).toHaveLength(1);
  });

  it('rejects softened mappings, token reuse, and unsafe ordering', () => {
    const rejected = credentialMutations().map(rejectsMutation);
    expect(rejected).toEqual(rejected.map(() => true));
  });
});

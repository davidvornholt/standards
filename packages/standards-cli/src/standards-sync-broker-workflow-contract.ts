import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { ACTUAL_UPSTREAM } from './cli-test-support';

type WorkflowStep = {
  readonly env?: Readonly<Record<string, string>>;
  readonly id?: string;
  readonly if?: string;
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Readonly<Record<string, string | boolean>>;
};
type ParsedWorkflow = {
  readonly permissions: Readonly<Record<string, string>>;
  readonly jobs: {
    readonly sync: { readonly steps: ReadonlyArray<WorkflowStep> };
  };
};
export type MutableWorkflow = {
  permissions: Record<string, string>;
  jobs: { sync: { steps: Array<WorkflowStep> } };
};

const workflowPath = join(
  ACTUAL_UPSTREAM,
  '.github/workflows/standards-sync.yml',
);
export const workflowSource = readFileSync(workflowPath, 'utf8');
export const parsedWorkflow = parseYaml(workflowSource) as ParsedWorkflow;
export const expression = (value: string): string =>
  ['$', '{{ ', value, ' }}'].join('');
export const namedStep = (
  workflow: ParsedWorkflow,
  name: string,
): WorkflowStep => {
  const step = workflow.jobs.sync.steps.find(
    (candidate) => candidate.name === name,
  );
  if (step === undefined) {
    throw new Error(`Missing Standards sync workflow step: ${name}`);
  }
  return step;
};
const stepIndex = (workflow: ParsedWorkflow, name: string): number =>
  workflow.jobs.sync.steps.findIndex((candidate) => candidate.name === name);
const changedCondition = "steps.mirror.outputs.changed == 'true'";
export const writerToken = expression(
  'steps.branch-writer-token.outputs.token',
);
export const prToken = expression('steps.pr-token.outputs.token');
const branchOutput = expression('steps.sync-branch.outputs.branch');
const resolveIdName = 'Resolve broker App ID';
const resolveKeyName = 'Resolve broker App private key';
export const writerMintName = 'Mint current-repository branch writer token';
export const prMintName = 'Mint current-repository PR token';
export const clearName = 'Clear broker App credentials';
export const syncName = 'Sync canonical files from upstream';
const writerTokenName = ['BRANCH', 'WRITER', 'TOKEN'].join('_');
const prTokenName = ['GH', 'TOKEN'].join('_');
export const syncPolicyRefName = ['SYNC', 'POLICY', 'REF'].join('_');

const assertExactStep = (
  workflow: ParsedWorkflow,
  name: string,
  expected: WorkflowStep,
): void => {
  if (!isDeepStrictEqual(namedStep(workflow, name), expected)) {
    throw new Error(`${name} does not match its exact workflow contract`);
  }
};
const resolvedSecretStep = (
  name: string,
  secretKey: string,
  envName: string,
): WorkflowStep => ({
  name,
  uses: './.github/actions/sops-secret',
  with: {
    'age-key': expression('secrets.SOPS_AGE_KEY'),
    'secret-file': 'secrets/ci.yaml',
    'secret-key': secretKey,
    'env-name': envName,
  },
});
const mintedTokenStep = (
  name: string,
  id: string,
  contents: string,
  permission: string,
): WorkflowStep => ({
  name,
  id,
  uses: 'actions/create-github-app-token@v3',
  with: {
    'app-id': expression('env.BROKER_APP_ID'),
    'private-key': expression('env.BROKER_APP_PRIVATE_KEY'),
    'permission-contents': contents,
    [permission]: 'write',
  },
});

export const assertSecuritySensitiveSteps = (
  workflow: ParsedWorkflow,
): void => {
  assertExactStep(
    workflow,
    resolveIdName,
    resolvedSecretStep(resolveIdName, 'broker_app.app_id', 'BROKER_APP_ID'),
  );
  assertExactStep(
    workflow,
    resolveKeyName,
    resolvedSecretStep(
      resolveKeyName,
      'broker_app.private_key',
      'BROKER_APP_PRIVATE_KEY',
    ),
  );
  assertExactStep(
    workflow,
    writerMintName,
    mintedTokenStep(
      writerMintName,
      'branch-writer-token',
      'write',
      'permission-workflows',
    ),
  );
  assertExactStep(
    workflow,
    prMintName,
    mintedTokenStep(prMintName, 'pr-token', 'read', 'permission-pull-requests'),
  );
  assertExactStep(workflow, clearName, {
    name: clearName,
    run: `{
  echo "BROKER_APP_ID="
  echo "BROKER_APP_PRIVATE_KEY="
} >> "$GITHUB_ENV"
`,
  });
  assertExactStep(workflow, 'Commit and push mirror changes', {
    name: 'Commit and push mirror changes',
    id: 'sync-branch',
    if: changedCondition,
    env: { [writerTokenName]: writerToken },
    run: `branch="standards-sync/$(date -u +%Y%m%d%H%M%S)"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git config --local credential.helper "!f() { echo username=x-access-token; echo \\"password=\\$BRANCH_WRITER_TOKEN\\"; }; f"
git switch -c "$branch"
git add -A
git commit -m "chore: sync standards from upstream"
git push --set-upstream origin "$branch"
git config --unset credential.helper
echo "branch=$branch" >> "$GITHUB_OUTPUT"
`,
  });
  assertExactStep(workflow, 'Open a pull request if the mirror changed', {
    name: 'Open a pull request if the mirror changed',
    if: changedCondition,
    env: { [prTokenName]: prToken },
    run: `gh pr create \\
  --head "${branchOutput}" \\
  --title "chore: sync standards from upstream" \\
  --body "Automated sync from davidvornholt/standards. These are canonical (read-only) files. Before merging, check out this sync branch; remove \\\`allow_merge_commit\\\`, \\\`allow_rebase_merge\\\`, and \\\`allow_squash_merge\\\` from \\\`.github/settings.local.json\\\` if that repo-owned seam still declares them; run \\\`bun standards github --apply\\\` with admin auth; push any seam cleanup; and wait for or rerun the GitHub settings gate. Merge only after every required check passes. Generated by the \\\`Standards sync\\\` workflow."
`,
  });

  const syncIndex = stepIndex(workflow, syncName);
  const resolveIdIndex = stepIndex(workflow, resolveIdName);
  const resolveKeyIndex = stepIndex(workflow, resolveKeyName);
  const writerIndex = stepIndex(workflow, writerMintName);
  const prIndex = stepIndex(workflow, prMintName);
  const clearIndex = stepIndex(workflow, clearName);
  const executableSyncIndexes = workflow.jobs.sync.steps.flatMap(
    (step, index) => (step.run?.includes('bun standards sync') ? [index] : []),
  );
  if (
    Math.max(resolveIdIndex, resolveKeyIndex) >=
      Math.min(writerIndex, prIndex) ||
    Math.max(writerIndex, prIndex) >= clearIndex ||
    clearIndex >= syncIndex ||
    executableSyncIndexes.length === 0 ||
    executableSyncIndexes.some((index) => clearIndex >= index)
  ) {
    throw new Error(
      'Broker credentials must resolve, mint, and clear before canonical sync',
    );
  }
  const serializedWorkflow = JSON.stringify(workflow);
  if (
    [writerToken, prToken].some(
      (token) => serializedWorkflow.split(token).length !== 2,
    )
  ) {
    throw new Error(
      'Each broker token must have exactly one workflow consumer',
    );
  }
};

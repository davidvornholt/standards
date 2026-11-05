import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTUAL_UPSTREAM,
  mkTmp,
  type RunResult,
  runProcess,
  write,
  yamlRunScript,
} from './cli-test-support';

export const AUTO_MERGE = join(
  ACTUAL_UPSTREAM,
  '.github/workflows/standards-auto-merge.yml',
);
export const SYNC = join(
  ACTUAL_UPSTREAM,
  '.github/workflows/standards-sync.yml',
);
export const APP = 'standards-broker';
export const PR_URL = 'https://github.com/owner/repo/pull/12';
const SHA_LENGTH = 40;
export const HEAD = 'a'.repeat(SHA_LENGTH);
const MODE = 0o755;

// GitHub's record of whether anyone turned a pull request's auto-merge off,
// and the call that reads it for pull request `number` of owner/repo. As on
// GitHub, totalCount ignores the itemTypes filter and also counts the pull
// request's commit; only the nodes are filtered.
export const disableRecord = (disabled: boolean) => ({
  'pages.json': {
    data: {
      repository: {
        pullRequest: {
          timelineItems: {
            totalCount: disabled ? 2 : 1,
            nodes: disabled ? [{ __typename: 'AutoMergeDisabledEvent' }] : [],
          },
        },
      },
    },
  },
});
export const readDisables = (number: number): string =>
  `api graphql -f owner=owner -f name=repo -F number=${number}\n`;

// GraphQL's answer to whether owner/repo allows auto-merge.
export const autoMergeSetting = (allowed: boolean) => ({
  'repository.json': { data: { repository: { autoMergeAllowed: allowed } } },
});

// Whether owner/repo allows auto-merge, and the active rules on its main
// branch, which may require `check`. A missing fixture fails the call.
export const autoMergeGate = ({
  allowed = true,
  required = ['check'],
}: {
  readonly allowed?: boolean;
  readonly required?: ReadonlyArray<string>;
} = {}) => ({
  ...autoMergeSetting(allowed),
  'rules.json': [
    { type: 'deletion' },
    {
      type: 'required_status_checks',
      parameters: {
        // biome-ignore lint/style/useNamingConvention: GitHub's rule field is snake_case.
        required_status_checks: required.map((context) => ({ context })),
      },
    },
  ],
});
export const readAutoMergeSetting = 'api graphql -f owner=owner -f name=repo\n';
export const readRequiredChecks =
  'api repos/owner/repo/rules/branches/main --paginate --jq .[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context\n';

// `pr view` applies the caller's `--jq` filter to the fixture pull request,
// the branch rules read applies it to the fixture rules, `api graphql`
// applies it to the fixture repository when the query reads the auto-merge
// setting and to the fixture pages otherwise, and records the variables
// without the query, `api --paginate` prints the fixture commit pages one
// after another as gh does, and `api --include` answers a merge with the
// fixture status for its base branch. Every call is recorded. Anything else
// fails, so a workflow can't lean on a gh call this fake only imagines.
const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  'pr view')
    echo "$*" >> "$GH_CALLS"
    while [ "$1" != --jq ]; do shift; done
    jq -r "$2" "$FIXTURE_DIR/pull-request.json"
    ;;
  'pr merge') echo "$*" >> "$GH_CALLS" ;;
  'api repos/'*'/rules/branches/'*)
    echo "$*" >> "$GH_CALLS"
    while [ "$1" != --jq ]; do shift; done
    jq -r "$2" "$FIXTURE_DIR/rules.json"
    ;;
  'api graphql')
    call='api graphql' filter=. fixture=pages.json
    shift 2
    while [ $# -gt 0 ]; do
      case "$1" in
        --jq) filter=$2; shift ;;
        -f | -F)
          case "$2" in
            query=*autoMergeAllowed*) fixture=repository.json ;;
            query=*) ;;
            *) call="$call $1 $2" ;;
          esac
          shift
          ;;
        *) call="$call $1" ;;
      esac
      shift
    done
    echo "$call" >> "$GH_CALLS"
    jq -r "$filter" "$FIXTURE_DIR/$fixture"
    ;;
  'api --paginate')
    echo "$*" >> "$GH_CALLS"
    jq -c '.[]' "$FIXTURE_DIR/commit-pages.json"
    ;;
  'api --include')
    echo "$*" >> "$GH_CALLS"
    status=$(jq -r --arg base "\${7#base=}" '.[$base] // 500' "$FIXTURE_DIR/statuses.json")
    printf 'HTTP/2.0 %s Fixture\\n\\n' "$status"
    [ "\${status:0:1}" = 2 ]
    ;;
  *) exit 1 ;;
esac
`;

// Step environments are name and value pairs; a later pair overrides an
// earlier one with the same name.
export type Env = ReadonlyArray<readonly [string, string]>;
export type Run = RunResult & {
  readonly calls: string;
  readonly output: string;
};
// Callers pass the inherited environment, so this module never reads process
// state.
export const stepRunner =
  (inherited: Readonly<Record<string, string | undefined>>) =>
  (
    path: string,
    name: string,
    fixtures: Readonly<Record<string, unknown>>,
    values: Env,
  ): Run => {
    const root = mkTmp('auto-merge-');
    write(root, 'bin/gh', FAKE_GH);
    chmodSync(join(root, 'bin/gh'), MODE);
    for (const [file, content] of Object.entries(fixtures)) {
      write(root, file, JSON.stringify(content));
    }
    const result = runProcess(
      'bash',
      root,
      ['-e', '-c', yamlRunScript(path, name)],
      {
        ...inherited,
        ...Object.fromEntries([
          ['PATH', `${join(root, 'bin')}:${inherited.PATH ?? ''}`],
          ['FIXTURE_DIR', root],
          ['GH_CALLS', join(root, 'calls')],
          ['GITHUB_OUTPUT', join(root, 'output')],
          ['GH_TOKEN', 'fixture-token'],
          ...values,
        ]),
      },
    );
    const read = (file: string): string =>
      existsSync(join(root, file))
        ? readFileSync(join(root, file), 'utf8')
        : '';
    return { ...result, calls: read('calls'), output: read('output') };
  };

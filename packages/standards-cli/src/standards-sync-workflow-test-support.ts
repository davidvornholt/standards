import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTUAL_UPSTREAM,
  type RunResult,
  runProcess,
  write,
  yamlRunScript,
} from './cli-test-support';

const MODE = 0o755;
const WORKFLOW = join(ACTUAL_UPSTREAM, '.github/workflows/standards-sync.yml');
export const SYNC_BRANCH = 'standards-sync/update';
export const RECONCILE_STEP = 'Reconcile sync pull requests';

export type FakePullRequest = {
  readonly number: number;
  readonly headRefName: string;
  readonly isCrossRepository: boolean;
};

// Callers pass the complete child-process environment, including the
// inherited one, so this module never reads process state.
export const runSyncStep = (
  cwd: string,
  name: string,
  environment: Readonly<Record<string, string | undefined>>,
): RunResult =>
  runProcess(
    'bash',
    cwd,
    [
      '-euo',
      'pipefail',
      '-c',
      yamlRunScript(WORKFLOW, name).replace(
        ['$', '{{ steps.sync-branch.outputs.branch }}'].join(''),
        SYNC_BRANCH,
      ),
    ],
    environment,
  );

// Open pull requests live in a JSON file. `pr list` applies the caller's
// `--jq` filter with real jq, `pr create` opens the reusable branch's PR with
// the next number, and `pr close` removes a PR and records its comment.
const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
state=$PR_STATE
[ -f "$state" ] || echo '[]' > "$state"
update() { jq "$@" "$state" > "$state.next"; mv "$state.next" "$state"; }
case "$1 $2" in
  'pr list')
    while [ "$1" != --jq ]; do shift; done
    jq -c "$2" "$state"
    ;;
  'pr create')
    if [ "$FAIL_CREATE" = true ] || [ "$4" != ${SYNC_BRANCH} ]; then exit 1; fi
    number=$(jq '[.[].number, 6] | max + 1' "$state")
    update --argjson number "$number" '. + [{number: $number, headRefName: "${SYNC_BRANCH}", isCrossRepository: false}]'
    echo created >> "$PR_CREATIONS"
    echo "https://github.com/owner/repo/pull/$number"
    ;;
  'pr close')
    if [ "$FAIL_CLOSE" = true ]; then exit 1; fi
    update --argjson number "$3" 'map(select(.number != $number))'
    printf '%s %s\\n' "$3" "$5" >> "$PR_CLOSURES"
    ;;
  *) exit 1 ;;
esac
`;

export const fakeGitHub = (
  root: string,
  inheritedPath: string,
): Record<string, string> => {
  write(root, 'bin/gh', FAKE_GH);
  chmodSync(join(root, 'bin/gh'), MODE);
  return Object.fromEntries([
    ['GH_TOKEN', 'pr-fixture'],
    ['PATH', `${join(root, 'bin')}:${inheritedPath}`],
    ['PR_STATE', join(root, 'pr-state')],
    ['PR_CREATIONS', join(root, 'pr-creations')],
    ['PR_CLOSURES', join(root, 'pr-closures')],
    ['FAIL_CREATE', 'false'],
    ['FAIL_CLOSE', 'false'],
  ]);
};

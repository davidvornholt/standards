import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTUAL_UPSTREAM,
  SOPS_ACTION,
  yamlRunScript,
} from './cli-test-support';

const workflow = join(ACTUAL_UPSTREAM, '.github/workflows/standards.yml');
export const artifact = `#!/usr/bin/env bash
[ -z "\${RELEASE_API_TOKEN+x}\${APP_RELEASE_GITHUB_TOKEN+x}\${release_api_token+x}" ] || exit 94
printf executed > "$EXECUTED"
printf '{"ci":{"token":"fixture"}}'
`;
export const checksum = createHash('sha256').update(artifact).digest('hex');
const releaseScript = readFileSync(
  join(ACTUAL_UPSTREAM, '.github/actions/app-release/release.sh'),
  'utf8',
);
const releasePreamble = releaseScript.slice(
  releaseScript.indexOf('set -euo pipefail'),
  releaseScript.indexOf('readonly name_pattern'),
);
const installer = releaseScript.slice(
  releaseScript.indexOf('install_sops() {'),
  releaseScript.indexOf('\nkey_file='),
);
// Exercise each embedded download/verification boundary directly. Workflow
// prefixes stop where archive extraction would begin, then execute a harmless
// fixture with a real SHA-256 check, so corrupt bytes cannot cross it.
export const scripts = [
  ['SOPS secret', yamlRunScript(SOPS_ACTION, 'Resolve and validate secret')],
  [
    'SOPS release',
    `${releasePreamble}\nfail() { exit 1; }\n${installer}\ninstall_sops\n"$sops"`,
  ],
  [
    'actionlint',
    `${yamlRunScript(workflow, 'Lint workflows').split('tar -xzf')[0]}bash "$archive"`,
  ],
  [
    'just',
    `${yamlRunScript(workflow, 'Install just').split('tar -xzf')[0]}bash "$archive"`,
  ],
  [
    'settings Bun',
    `${yamlRunScript(workflow, 'Install pinned settings checker').split('mkdir "$bun_root"')[0]}bash "$bun_archive"`,
  ],
] as const;

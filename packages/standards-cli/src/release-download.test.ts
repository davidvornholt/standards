import { afterEach, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import {
  ACTUAL_UPSTREAM,
  cleanupTmpDirs,
  mkTmp,
  runProcess,
  SOPS_ACTION,
  write,
  yamlRunScript,
} from './cli-test-support';

const workflow = join(ACTUAL_UPSTREAM, '.github/workflows/standards.yml');
const artifact =
  '#!/usr/bin/env bash\nprintf executed > "$EXECUTED"\nprintf \'{"ci":{"token":"fixture"}}\'\n';
const checksum = createHash('sha256').update(artifact).digest('hex');
const releaseScript = readFileSync(
  join(ACTUAL_UPSTREAM, '.github/actions/app-release/release.sh'),
  'utf8',
);
const installer = releaseScript.slice(
  releaseScript.indexOf('install_sops() {'),
  releaseScript.indexOf('\nkey_file='),
);
// Exercise each embedded download/verification boundary directly. Workflow
// prefixes stop where archive extraction would begin, then execute a harmless
// fixture with a real SHA-256 check, so corrupt bytes cannot cross it.
const scripts = [
  ['SOPS secret', yamlRunScript(SOPS_ACTION, 'Resolve and validate secret')],
  [
    'SOPS release',
    `set -euo pipefail\nfail() { exit 1; }\nwork="$RUNNER_TEMP"\n${installer}\ninstall_sops\n"$sops"`,
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

afterEach(cleanupTmpDirs);

const runInstaller = (script: string, mode: string, architecture: string) => {
  const root = mkTmp('release-download-');
  const bin = join(root, 'bin');
  const executed = join(root, 'executed');
  const calls = join(root, 'calls');
  write(root, 'artifact', artifact);
  write(root, 'secrets.yaml', 'encrypted fixture');
  write(
    root,
    'bin/uname',
    '#!/usr/bin/env bash\nprintf "%s" "$ARCHITECTURE"\n',
  );
  write(
    root,
    'bin/curl',
    `#!/usr/bin/env bash
set -euo pipefail
url="\${@: -1}"
printf '%s\\n' "$url" >> "$CALLS"
case "$url" in
  https://github.com/*/releases/download/*)
    if [ "$MODE" = direct ]; then cp "$ARTIFACT" "$2"; exit 0; fi
    if [ "$MODE" = direct-corrupt ]; then printf corrupt > "$2"; exit 0; fi
    printf partial > "$2"; exit 22 ;;
  https://api.github.com/repos/*/releases/assets/*)
    [[ "$*" == *"Accept: application/octet-stream"* ]] || exit 90
    if [ "$MODE" = failed ]; then printf partial > "$2"; exit 22; fi
    if [ "$MODE" = corrupt ]; then printf corrupt > "$2"; exit 0; fi
    cp "$ARTIFACT" "$2" ;;
  *) exit 91 ;;
esac
`,
  );
  chmodSync(join(bin, 'curl'), 0o755);
  chmodSync(join(bin, 'uname'), 0o755);
  const result = runProcess(
    'bash',
    root,
    ['-euo', 'pipefail', '-c', script.replace(/[a-f0-9]{64}/gu, checksum)],
    {
      ...process.env,
      ...Object.fromEntries([
        ['PATH', `${bin}:${process.env.PATH}`],
        ['RUNNER_TEMP', root],
        ['ARCHITECTURE', architecture],
        ['ARTIFACT', join(root, 'artifact')],
        ['CALLS', calls],
        ['EXECUTED', executed],
        ['MODE', mode],
        ['SOPS_AGE_KEY', 'fixture'],
        ['SOPS_SECRET_ROOT', 'ci'],
        ['SOPS_SECRET_KEY', 'token'],
        ['SOPS_SECRET_FILE', join(root, 'secrets.yaml')],
        ['GITHUB_OUTPUT', join(root, 'output')],
      ]),
    },
  );
  return {
    result,
    executed: existsSync(executed),
    calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '',
  };
};

for (const architecture of ['x86_64', 'aarch64']) {
  it.each(scripts)(
    `%s verifies the API fallback before execution on ${architecture}`,
    (_name, script) => {
      const run = runInstaller(script, 'fallback', architecture);
      expect(run.result.status).toBe(0);
      expect(run.executed).toBe(true);
      expect(run.calls).toContain('https://github.com/');
      expect(run.calls).toContain('/releases/assets/');
    },
  );
}

for (const mode of ['corrupt', 'failed', 'direct-corrupt']) {
  it.each(scripts)(
    `%s never executes an artifact when ${mode}`,
    (_name, script) => {
      const run = runInstaller(script, mode, 'x86_64');
      expect(run.result.status).not.toBe(0);
      expect(run.executed).toBe(false);
      expect(run.calls.includes('/releases/assets/')).toBe(
        mode !== 'direct-corrupt',
      );
    },
  );
}

it.each(scripts)('%s keeps the successful direct path', (_name, script) => {
  const run = runInstaller(script, 'direct', 'x86_64');
  expect(run.result.status).toBe(0);
  expect(run.executed).toBe(true);
  expect(run.calls).not.toContain('/releases/assets/');
});

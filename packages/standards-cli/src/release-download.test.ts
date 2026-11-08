import { afterEach, expect, it } from 'bun:test';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { cleanupTmpDirs, mkTmp, runProcess, write } from './cli-test-support';

import { artifact, checksum, scripts } from './release-download-test-support';

afterEach(cleanupTmpDirs);

const runInstaller = (
  script: string,
  mode: string,
  architecture: string,
  token = 'fixture-api-token',
) => {
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
[ "$1" = --disable ] || exit 93
[ -z "\${RELEASE_API_TOKEN+x}\${APP_RELEASE_GITHUB_TOKEN+x}\${release_api_token+x}" ] || exit 94
[[ "$*" != *fixture-api-token* ]] || exit 95
output=""
previous=""
for argument; do
  if [ "$previous" = -sSfLo ]; then output=$argument; fi
  previous=$argument
done
printf '%s\\n' "$url" >> "$CALLS"
case "$url" in
  https://github.com/*/releases/download/*)
    if [ "$MODE" = direct ]; then cp "$ARTIFACT" "$output"; exit 0; fi
    if [ "$MODE" = direct-corrupt ]; then printf corrupt > "$output"; exit 0; fi
    printf partial > "$output"; exit 22 ;;
  https://api.github.com/repos/*/releases/assets/*)
    [[ "$*" == *"Accept: application/octet-stream"* && "$*" == *"-H @-"* ]] || exit 90
    IFS= read -r authorization
    [ "$authorization" = 'Authorization: Bearer fixture-api-token' ] || exit 96
    if [ "$MODE" = failed ]; then printf partial > "$output"; exit 22; fi
    if [ "$MODE" = corrupt ]; then printf corrupt > "$output"; exit 0; fi
    cp "$ARTIFACT" "$output" ;;
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
        ['APP_RELEASE_WORK_DIR', root],
        [
          script.includes('install_sops()')
            ? 'APP_RELEASE_GITHUB_TOKEN'
            : 'RELEASE_API_TOKEN',
          token,
        ],
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
      expect(run.result.stdout + run.result.stderr + run.calls).not.toContain(
        'fixture-api-token',
      );
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
  expect(run.result.stdout + run.result.stderr + run.calls).not.toContain(
    'fixture-api-token',
  );
  expect(run.executed).toBe(true);
  expect(run.calls).not.toContain('/releases/assets/');
});

for (const token of [
  '',
  'fixture\rInjected: header',
  'fixture\nInjected: header',
]) {
  it.each(scripts)(
    '%s rejects absent or multiline API credentials before downloading',
    (_name, script) => {
      const run = runInstaller(script, 'fallback', 'x86_64', token);
      expect(run.result.status).not.toBe(0);
      expect(run.executed).toBe(false);
      expect(run.calls).toBe('');
      expect(run.result.stdout + run.result.stderr).not.toContain('Injected');
    },
  );
}

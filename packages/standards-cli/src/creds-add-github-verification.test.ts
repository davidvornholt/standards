import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { runCredsAddGithub } from './creds-add-github';

const EXECUTABLE_MODE = 0o755;
const roots: Array<string> = [];
const originalBroker = process.env.STANDARDS_BROKER_FILE;
const originalFetch = globalThis.fetch;
const originalPath = process.env.PATH;
const PRIVATE_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
})
  .privateKey.export({ format: 'pem', type: 'pkcs1' })
  .toString();

const setup = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'creds-add-github-verify-'));
  roots.push(root);
  const consumer = join(root, 'consumer');
  mkdirSync(join(consumer, 'secrets'), { recursive: true });
  writeFileSync(
    join(consumer, 'secrets', 'ci.yaml'),
    'ci:\n  broker_app:\n    app_id: old\nsops:\n  version: 3.9.4\n',
  );
  execFileSync('git', ['init', '-q', consumer]);
  execFileSync('git', [
    '-C',
    consumer,
    'remote',
    'add',
    'origin',
    'git@github.com:example/repository.git',
  ]);
  const broker = join(root, 'broker.yaml');
  writeFileSync(
    broker,
    `github:
  - owner: example
    app_id: 2
    slug: example-app
    html_url: https://github.com/apps/example-app
    client_id: Iv1.example
    private_key: |
${PRIVATE_KEY.split('\n')
  .map((line) => `      ${line}`)
  .join('\n')}
`,
  );
  process.env.STANDARDS_BROKER_FILE = broker;
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const sops = join(bin, 'sops');
  writeFileSync(
    sops,
    `#!/bin/sh
if [ "$1" = "edit" ]; then
  eval "$SOPS_EDITOR \\"$2\\""
  exit $?
fi
if [ "$1" = "decrypt" ]; then
  case "$3" in
    *app_id*) printf 'different-app-id' ;;
    *) printf 'different-private-key' ;;
  esac
  exit 0
fi
exit 1
`,
  );
  chmodSync(sops, EXECUTABLE_MODE);
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
  globalThis.fetch = (() =>
    Promise.resolve(
      Response.json({
        // biome-ignore lint/style/useNamingConvention: GitHub's installation response uses snake_case.
        app_id: 2,
        account: { login: 'example' },
      }),
    )) as unknown as typeof fetch;
  return consumer;
};

afterEach(() => {
  mock.restore();
  globalThis.fetch = originalFetch;
  process.env.PATH = originalPath;
  if (originalBroker === undefined) {
    delete process.env.STANDARDS_BROKER_FILE;
  } else {
    process.env.STANDARDS_BROKER_FILE = originalBroker;
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('GitHub credential exact-value verification', () => {
  it('fails without success output when SOPS returns different scalar credentials', async () => {
    mock.restore();
    const consumer = setup();
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    const log = spyOn(console, 'log').mockImplementation(() => undefined);

    expect(
      await runCredsAddGithub(consumer, { dest: 'ci:ci.broker_app' }),
    ).toBe(false);

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('does not match the selected GitHub App'),
    );
    expect(log.mock.calls.join(' ')).not.toContain(
      'standards creds: wrote App',
    );
  });
});

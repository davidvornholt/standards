import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { runCredsAddGithub } from './creds-add-github';
import { runCredsCommand } from './creds-commands';

const HTTP_NOT_FOUND = 404;
const roots: Array<string> = [];
const originalBroker = process.env.STANDARDS_BROKER_FILE;
const originalFetch = globalThis.fetch;
const PRIVATE_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
})
  .privateKey.export({ format: 'pem', type: 'pkcs1' })
  .toString();

const setup = (): { readonly consumer: string; readonly secrets: string } => {
  const root = mkdtempSync(join(tmpdir(), 'creds-github-command-'));
  roots.push(root);
  const consumer = join(root, 'consumer');
  const secrets = join(consumer, 'secrets', 'ci.yaml');
  mkdirSync(join(consumer, 'secrets'), { recursive: true });
  writeFileSync(
    secrets,
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
  - owner: personal
    app_id: 1
    slug: personal-app
    html_url: https://github.com/apps/personal-app
    client_id: Iv1.personal
    private_key: personal-key
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
  return { consumer, secrets };
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBroker === undefined) {
    delete process.env.STANDARDS_BROKER_FILE;
  } else {
    process.env.STANDARDS_BROKER_FILE = originalBroker;
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('GitHub credential commands', () => {
  it('shows every configured App with its owner', async () => {
    setup();
    const log = spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await runCredsCommand(['status'])).toBe(true);

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('personal: App personal-app'),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('example: App example-app'),
    );
  });

  it('does not touch SOPS when the selected App lacks repository installation', async () => {
    const { consumer, secrets } = setup();
    const before = readFileSync(secrets);
    globalThis.fetch = ((_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(
        Response.json({ message: 'Not Found' }, { status: HTTP_NOT_FOUND }),
      )) as typeof fetch;
    const error = spyOn(console, 'error').mockImplementation(() => undefined);

    expect(
      await runCredsAddGithub(consumer, { dest: 'ci:ci.broker_app' }),
    ).toBe(false);

    expect(readFileSync(secrets)).toEqual(before);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('is not installed on example/repository'),
    );
  });
});

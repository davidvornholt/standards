import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadOwnedGithubStore,
  selectGithubAppForRepo,
  upsertGithubApp,
} from './creds-github-apps';
import { readBrokerStore } from './creds-store';

const dirs: Array<string> = [];
const REPLACEMENT_APP_ID = 3;
const SECOND_ORG_APP_ID = 4;
const storePath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'creds-github-apps-'));
  dirs.push(dir);
  return join(dir, 'broker.yaml');
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const app = (owner: string | null, appId: number) => ({
  owner,
  appId,
  slug: `standards-broker-${appId}`,
  htmlUrl: `https://github.com/apps/standards-broker-${appId}`,
  clientId: `Iv1.${appId}`,
  privateKey: `private-${appId}`,
});

const legacyYaml = `github:
  app_id: 1
  slug: standards-broker
  html_url: https://github.com/apps/standards-broker
  client_id: Iv1.1
  private_key: private-1
`;

describe('GitHub broker App store migration', () => {
  it('resolves and atomically migrates the legacy singleton shape', async () => {
    const path = storePath();
    writeFileSync(path, legacyYaml);

    const loaded = await loadOwnedGithubStore(path, () =>
      Promise.resolve({ ok: true, value: 'davidvornholt' }),
    );

    expect(loaded).toEqual({
      ok: true,
      value: {
        github: [
          {
            ...app('davidvornholt', 1),
            slug: 'standards-broker',
            htmlUrl: 'https://github.com/apps/standards-broker',
          },
        ],
        cloudflare: [],
      },
    });
    expect(readFileSync(path, 'utf8')).toContain(
      'github:\n  - owner: davidvornholt',
    );
  });

  it('leaves the singleton bytes untouched when owner lookup fails', async () => {
    const path = storePath();
    writeFileSync(path, legacyYaml);

    const loaded = await loadOwnedGithubStore(path, () =>
      Promise.resolve({ ok: false, problem: 'offline' }),
    );

    expect(loaded).toEqual({
      ok: false,
      problem: `cannot migrate the legacy singleton GitHub App in ${path}: offline`,
    });
    expect(readFileSync(path, 'utf8')).toBe(legacyYaml);
  });

  it('leaves the singleton bytes untouched when owner lookup is invalid', async () => {
    const path = storePath();
    writeFileSync(path, legacyYaml);

    await expect(
      loadOwnedGithubStore(path, () =>
        Promise.resolve({ ok: true, value: '' }),
      ),
    ).rejects.toThrow('invalid GitHub App');

    expect(readFileSync(path, 'utf8')).toBe(legacyYaml);
  });

  it('rejects duplicate owners case-insensitively', () => {
    const path = storePath();
    writeFileSync(
      path,
      `github:
  - owner: Example
    app_id: 1
    slug: one
    html_url: https://github.com/apps/one
    client_id: Iv1.1
    private_key: key-1
  - owner: example
    app_id: 2
    slug: two
    html_url: https://github.com/apps/two
    client_id: Iv1.2
    private_key: key-2
`,
    );

    expect(readBrokerStore(path)).rejects.toThrow(
      'duplicate GitHub owner example',
    );
  });
});

describe('GitHub broker App selection', () => {
  it('selects by destination repository owner', () => {
    expect(
      selectGithubAppForRepo(
        [app('personal', 1), app('Example-Org', 2)],
        'example-org/repository',
      ),
    ).toEqual({ ok: true, value: app('Example-Org', 2) });
  });

  it('reports missing and ambiguous owner matches actionably', () => {
    const missing = selectGithubAppForRepo(
      [app('other', 1)],
      'example/repository',
    );
    expect(missing).toEqual({
      ok: false,
      problem: expect.stringContaining(
        'no broker GitHub App is configured for repository owner example',
      ),
    });
    const ambiguous = selectGithubAppForRepo(
      [app('example', 1), app('EXAMPLE', 2)],
      'example/repository',
    );
    expect(ambiguous).toEqual({
      ok: false,
      problem: expect.stringContaining(
        'multiple broker GitHub Apps are configured',
      ),
    });
  });

  it('upserts one owner without replacing another account', () => {
    const initial = [app('personal', 1), app('example-org', 2)];
    expect(
      upsertGithubApp(initial, app('EXAMPLE-ORG', REPLACEMENT_APP_ID)),
    ).toEqual({
      apps: [app('personal', 1), app('EXAMPLE-ORG', REPLACEMENT_APP_ID)],
      replaced: app('example-org', 2),
    });
    expect(
      upsertGithubApp(initial, app('second-org', SECOND_ORG_APP_ID)),
    ).toEqual({
      apps: [...initial, app('second-org', SECOND_ORG_APP_ID)],
      replaced: null,
    });
  });
});

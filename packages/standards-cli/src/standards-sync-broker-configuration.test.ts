import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ACTUAL_UPSTREAM } from './cli-test-support';

const WORKFLOW_PATH = join(
  ACTUAL_UPSTREAM,
  '.github/workflows/standards-sync.yml',
);
const SOURCE_POLICY_PATH = join(ACTUAL_UPSTREAM, 'sync-standards.local.json');
const SOURCE_EXAMPLE_PATH = join(ACTUAL_UPSTREAM, 'secrets/ci.example.yaml');
const SOURCE_SECRETS_PATH = join(ACTUAL_UPSTREAM, 'secrets/ci.yaml');
const TEMPLATE_EXAMPLE_PATH = join(
  ACTUAL_UPSTREAM,
  'template/secrets/ci.example.yaml',
);
const STRUCTURE_SECRETS_PATH = join(
  ACTUAL_UPSTREAM,
  'packages/standards-cli/src/structure-secrets.ts',
);
const OBSOLETE_SYNC_KEY = ['standards', 'sync', 'token'].join('_');
// The retired settings PAT. Nothing reads it any more, so a seeded example that
// still carries it would send every adopter to mint a credential for nothing.
const OBSOLETE_SETTINGS_KEY = ['github', 'settings', 'read', 'token'].join('_');
const BROKER_DESTINATION = 'ci:ci.broker_app';
const PROVISION_BROKER_COMMAND =
  'bun standards creds add github --dest ci:ci.broker_app';
const WRITER_PERMISSIONS = 'Contents write and Workflows write';
const PR_PERMISSIONS = 'Contents read and Pull requests write';
const OBSOLETE_ONE_TOKEN_GUIDANCE = [
  'mints a short-lived token with Contents read and Pull requests write',
  'mints its pull request token from ci.broker_app',
];
const MINIMUM_STANDARDS_VERSION_PATTERN =
  /MINIMUM_STANDARDS_VERSION: "\d+\.\d+\.\d+"/u;

const readSource = (path: string): string =>
  readFileSync(join(ACTUAL_UPSTREAM, path), 'utf8');

const brokerAppMapping = (
  document: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const ci = document.ci as Readonly<Record<string, unknown>>;
  const brokerEntry = Object.entries(ci).find(
    ([key]) => key === ['broker', 'app'].join('_'),
  );
  return brokerEntry?.[1] as Readonly<Record<string, unknown>>;
};

describe('Standards sync broker configuration', () => {
  it('keeps examples identical without retired credentials', () => {
    const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
    const source = readFileSync(SOURCE_EXAMPLE_PATH, 'utf8');
    const template = readFileSync(TEMPLATE_EXAMPLE_PATH, 'utf8');
    const parsed = parseYaml(source) as {
      readonly ci: Readonly<Record<string, unknown>>;
    };
    const brokerApp = brokerAppMapping(parsed);

    expect(source).toBe(template);
    expect(workflow).not.toContain(OBSOLETE_SYNC_KEY);
    expect(source).not.toContain(OBSOLETE_SYNC_KEY);
    expect(source).not.toContain(OBSOLETE_SETTINGS_KEY);
    expect(template).not.toContain(OBSOLETE_SETTINGS_KEY);
    expect(Object.keys(brokerApp).sort()).toEqual(['app_id', 'private_key']);
    expect(
      Object.values(brokerApp).every((value) => typeof value === 'string'),
    ).toBe(true);
  });

  it('tracks both broker App leaves as encrypted source secrets', () => {
    const encrypted = parseYaml(
      readFileSync(SOURCE_SECRETS_PATH, 'utf8'),
    ) as Readonly<Record<string, unknown>>;
    const brokerApp = brokerAppMapping(encrypted);

    expect(Object.keys(brokerApp).sort()).toEqual(['app_id', 'private_key']);
    expect(
      Object.values(brokerApp).every(
        (value) =>
          typeof value === 'string' && value.startsWith('ENC[AES256_GCM,'),
      ),
    ).toBe(true);
  });

  it('opts the source repository out of consuming itself', () => {
    expect(JSON.parse(readFileSync(SOURCE_POLICY_PATH, 'utf8'))).toEqual({
      autoSync: false,
    });
  });
});

describe('Standards sync broker documentation contract', () => {
  it('keeps provisioning in focused guides and exact roles in authoritative contracts', () => {
    const rootReadme = readSource('README.md');
    const adoptionGuide = readSource('docs/adoption.md');
    const cliReadme = readSource('packages/standards-cli/README.md');
    const syncSkill = readSource('.agents/skills/standards-sync/SKILL.md');
    const syncGithubReference = readSource(
      '.agents/skills/standards-sync/references/github.md',
    );
    const secretsReference = readSource(
      '.agents/skills/declarative-infra/references/secrets.md',
    );
    const sourceExample = readFileSync(SOURCE_EXAMPLE_PATH, 'utf8');
    const templateExample = readFileSync(TEMPLATE_EXAMPLE_PATH, 'utf8');
    const structureSecrets = readFileSync(STRUCTURE_SECRETS_PATH, 'utf8');

    for (const document of [adoptionGuide, cliReadme, secretsReference]) {
      expect(document).toContain(BROKER_DESTINATION);
      expect(document).toContain(PROVISION_BROKER_COMMAND);
    }

    for (const document of [
      secretsReference,
      sourceExample,
      templateExample,
      structureSecrets,
    ]) {
      expect(document).toContain(BROKER_DESTINATION);
      expect(document).toContain(WRITER_PERMISSIONS);
      expect(document).toContain(PR_PERMISSIONS);
    }

    expect(syncSkill).toContain('(references/github.md)');
    expect(syncGithubReference).toContain('ci.broker_app');
    expect(syncGithubReference).toContain('short-lived tokens');
    expect(syncGithubReference).toContain('there is no fallback credential');
    expect(rootReadme).toContain('[Adoption](docs/adoption.md)');
    expect(rootReadme).toContain(
      '[Sync and ownership](docs/sync-and-ownership.md)',
    );

    for (const document of [
      rootReadme,
      adoptionGuide,
      cliReadme,
      syncSkill,
      syncGithubReference,
      secretsReference,
      sourceExample,
      templateExample,
      structureSecrets,
    ]) {
      expect(document).not.toContain(OBSOLETE_SYNC_KEY);
      expect(document).not.toContain(OBSOLETE_SETTINGS_KEY);
      for (const obsolete of OBSOLETE_ONE_TOKEN_GUIDANCE) {
        expect(document).not.toContain(obsolete);
      }
    }
  });

  it('documents policy-aware recovery without keeping release history in the landing page', () => {
    const rootReadme = readSource('README.md');
    const syncGuide = readSource('docs/sync-and-ownership.md');
    const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
    const upgrade =
      'first upgrade the exact `@davidvornholt/standards` dependency and `bun.lock` with Bun.';
    const trackingMain = 'A consumer tracking `main`';
    const pinned = 'A pinned consumer';

    expect(workflow).toMatch(MINIMUM_STANDARDS_VERSION_PATTERN);
    expect(workflow).toContain(
      'upgrade package.json and bun.lock before accepting this workflow',
    );
    expect(syncGuide).toContain(upgrade);
    expect(syncGuide.indexOf(upgrade)).toBeLessThan(
      syncGuide.indexOf(trackingMain),
    );
    expect(syncGuide.indexOf(upgrade)).toBeLessThan(syncGuide.indexOf(pinned));
    expect(syncGuide).toContain(
      'A plain sync without that policy change follows the old pin and cannot fetch it.',
    );
    expect(syncGuide).toContain(
      'does not need to expand or approve its broker App permissions until scheduled sync is re-enabled.',
    );
    expect(rootReadme).not.toContain(upgrade);
  });
});

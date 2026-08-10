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
// still carries it would send every adopter to mint a credential for nothing —
// and `template/secrets/ci.example.yaml` is what new consumers start from.
const OBSOLETE_SETTINGS_KEY = ['github', 'settings', 'read', 'token'].join('_');
const BROKER_DESTINATION = 'ci:ci.broker_app';
const WRITER_PERMISSIONS = 'Contents write and Workflows write';
const PR_PERMISSIONS = 'Contents read and Pull requests write';
const OBSOLETE_ONE_TOKEN_GUIDANCE = [
  'mints a short-lived token with Contents read and Pull requests write',
  'mints its pull request token from ci.broker_app',
];

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
  it('documents both token roles and one provisioning command everywhere', () => {
    const rootReadme = readFileSync(join(ACTUAL_UPSTREAM, 'README.md'), 'utf8');
    const documents = [
      'packages/standards-cli/README.md',
      '.agents/skills/standards-sync/SKILL.md',
      '.agents/skills/declarative-infra/references/secrets.md',
    ].map((path) => readFileSync(join(ACTUAL_UPSTREAM, path), 'utf8'));
    const sourceOwnedGuidance = [
      rootReadme,
      ...documents,
      readFileSync(SOURCE_EXAMPLE_PATH, 'utf8'),
      readFileSync(TEMPLATE_EXAMPLE_PATH, 'utf8'),
      readFileSync(STRUCTURE_SECRETS_PATH, 'utf8'),
    ];

    for (const document of sourceOwnedGuidance) {
      expect(document).toContain(BROKER_DESTINATION);
      expect(document).toContain(WRITER_PERMISSIONS);
      expect(document).toContain(PR_PERMISSIONS);
      expect(document).not.toContain(OBSOLETE_SYNC_KEY);
      for (const obsolete of OBSOLETE_ONE_TOKEN_GUIDANCE) {
        expect(document).not.toContain(obsolete);
      }
    }
    // Current guidance must not instruct anyone to provision the retired PAT.
    // The root README is excluded deliberately: it names the key in dated
    // migration notes, which stay accurate as history.
    for (const document of documents) {
      expect(document).not.toContain(OBSOLETE_SETTINGS_KEY);
    }
    expect(rootReadme).toContain('`@davidvornholt/standards` 0.14.0 or newer');
    expect(rootReadme).toContain('`bun.lock`');
    expect(rootReadme).not.toContain('current 0.12 workflow');
    expect(rootReadme).toContain(
      'the 0.21 dev-env composition cutover raises it to 0.21.0',
    );
  });

  it('keeps the workflow repair bootstrap policy-aware', () => {
    const rootReadme = readFileSync(join(ACTUAL_UPSTREAM, 'README.md'), 'utf8');
    const upgrade =
      'First upgrade the exact `@davidvornholt/standards` dependency and `bun.lock` to at least 0.21.0 with Bun.';
    const trackingMain = 'A tracking-main consumer';
    const pinned = 'A pinned consumer';

    expect(rootReadme).toContain(upgrade);
    expect(rootReadme.indexOf(upgrade)).toBeLessThan(
      rootReadme.indexOf(trackingMain),
    );
    expect(rootReadme.indexOf(upgrade)).toBeLessThan(
      rootReadme.indexOf(pinned),
    );
    expect(rootReadme).toContain(
      'A pinned consumer first updates the checked-in `sync-standards.local.json.ref`',
    );
    expect(rootReadme).toContain(
      'a plain sync without that policy change honors the old pin and cannot fetch the repair',
    );
    expect(rootReadme).toContain(
      'does not need to expand or approve its broker App permissions until scheduled sync is re-enabled',
    );
  });
});

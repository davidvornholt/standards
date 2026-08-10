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
const OBSOLETE_SYNC_KEY = ['standards', 'sync', 'token'].join('_');
// The retired settings PAT. Nothing reads it any more, so a seeded example that
// still carries it would send every adopter to mint a credential for nothing —
// and `template/secrets/ci.example.yaml` is what new consumers start from.
const OBSOLETE_SETTINGS_KEY = ['github', 'settings', 'read', 'token'].join('_');
const BROKER_DESTINATION = 'ci:ci.broker_app';

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
  it('documents one provisioning command across source-owned guidance', () => {
    const rootReadme = readFileSync(join(ACTUAL_UPSTREAM, 'README.md'), 'utf8');
    const documents = [
      'packages/standards-cli/README.md',
      '.agents/skills/standards-sync/SKILL.md',
      '.agents/skills/declarative-infra/references/secrets.md',
    ].map((path) => readFileSync(join(ACTUAL_UPSTREAM, path), 'utf8'));

    for (const document of [rootReadme, ...documents]) {
      expect(document).toContain(BROKER_DESTINATION);
      expect(document).not.toContain(OBSOLETE_SYNC_KEY);
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
});

import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectCiSecretsProblems } from './structure-secrets';
import {
  CI_EXAMPLE_YAML,
  CI_SECRETS_YAML,
  cleanupStructureTmps,
  FAKE_ENC,
  newStructureTmp,
  writeInto as write,
} from './structure-test-support';

afterEach(cleanupStructureTmps);

const SOPS_METADATA = /sops:[\s\S]*$/u;
const REQUIRED_KEYS = [
  ['ntfy_topic_url', 'ci.ntfy_topic_url'],
  ['app_id', 'ci.broker_app.app_id'],
  ['private_key', 'ci.broker_app.private_key'],
] as const;
const NON_STRING_TYPES = ['bool', 'bytes', 'comment', 'float', 'int'] as const;
const SOPS_3_13_TWO_AGE_KEY_GROUPS = readFileSync(
  join(import.meta.dir, 'fixtures/sops-3.13-two-age-key-groups.yaml'),
  'utf8',
);
const REQUIRED_TYPE_CASES = REQUIRED_KEYS.flatMap(([key, path]) =>
  NON_STRING_TYPES.map((type) => [key, path, type] as const),
);

const directSources = [
  ['age', '  age:\n    - recipient: age1test\n      enc: recipient-envelope'],
  [
    'azure_kv',
    '  azure_kv:\n    - vault_url: https://vault.example\n      name: key\n      version: one\n      created_at: "2026-08-05T00:00:00Z"\n      enc: recipient-envelope',
  ],
  [
    'gcp_kms',
    '  gcp_kms:\n    - resource_id: projects/p/locations/l/keyRings/r/cryptoKeys/k\n      created_at: "2026-08-05T00:00:00Z"\n      enc: recipient-envelope',
  ],
  [
    'hc_vault',
    '  hc_vault:\n    - vault_address: https://vault.example\n      engine_path: transit\n      key_name: key\n      created_at: "2026-08-05T00:00:00Z"\n      enc: recipient-envelope',
  ],
  [
    'kms',
    '  kms:\n    - arn: arn:aws:kms:eu-west-1:123:key/test\n      created_at: "2026-08-05T00:00:00Z"\n      enc: recipient-envelope',
  ],
  [
    'pgp',
    '  pgp:\n    - created_at: "2026-08-05T00:00:00Z"\n      enc: recipient-envelope\n      fp: ABCDEF',
  ],
] as const;
const MALFORMED_DIRECT_SOURCES = directSources.flatMap(([source]) => [
  [`empty ${source} list`, `  ${source}: []`] as const,
  [`null ${source} entry`, `  ${source}:\n    - null`] as const,
  [`empty ${source} entry`, `  ${source}:\n    - {}`] as const,
]);

const buildSecrets = (): string => {
  const dir = newStructureTmp('structure-sops-repair-');
  write(dir, 'secrets/ci.yaml', CI_SECRETS_YAML);
  write(dir, 'secrets/ci.example.yaml', CI_EXAMPLE_YAML);
  return dir;
};

const withMetadata = (yaml: string, recipients: string): string =>
  yaml.replace(
    SOPS_METADATA,
    `sops:\n${recipients}\n  version: 3.9.0\n  mac: ${FAKE_ENC}\n`,
  );

describe('required SOPS scalar types', () => {
  it.each(REQUIRED_TYPE_CASES)(
    'rejects complete type:%s envelope at %s when its type is %s',
    async (key, path, type) => {
      const dir = buildSecrets();
      const typed = CI_SECRETS_YAML.replace(
        new RegExp(`^(\\s+${key}: ENC\\[[^\\n]+)type:str\\]$`, 'mu'),
        `$1type:${type}]`,
      );
      write(dir, 'secrets/ci.yaml', typed);
      expect(await collectCiSecretsProblems(dir)).toContain(
        `secrets/ci.yaml: required key "${path}" must be one SOPS-encrypted string scalar because its workflow resolves it as a string`,
      );
    },
  );
});

describe('SOPS recipient metadata structure', () => {
  it.each(directSources)(
    'accepts a complete %s recipient entry',
    async (_source, block) => {
      const dir = buildSecrets();
      write(dir, 'secrets/ci.yaml', withMetadata(CI_SECRETS_YAML, block));
      expect(await collectCiSecretsProblems(dir)).toEqual([]);
    },
  );

  it.each(MALFORMED_DIRECT_SOURCES)('rejects %s', async (_label, block) => {
    const dir = buildSecrets();
    write(dir, 'secrets/ci.yaml', withMetadata(CI_SECRETS_YAML, block));
    expect(await collectCiSecretsProblems(dir)).toContain(
      'secrets/ci.yaml: incomplete top-level "sops" metadata; encrypt the file with SOPS before committing it',
    );
  });

  it.each([
    ['empty list', '  key_groups: []'],
    ['null group', '  key_groups:\n    - null'],
    ['empty group', '  key_groups:\n    - {}'],
    ['empty nested source', '  key_groups:\n    - age: []'],
    ['null nested recipient', '  key_groups:\n    - age:\n        - null'],
  ])('rejects %s in key-group metadata', async (_label, block) => {
    const dir = buildSecrets();
    write(dir, 'secrets/ci.yaml', withMetadata(CI_SECRETS_YAML, block));
    expect(await collectCiSecretsProblems(dir)).toContain(
      'secrets/ci.yaml: incomplete top-level "sops" metadata; encrypt the file with SOPS before committing it',
    );
  });

  it('accepts a key group containing a complete recipient', async () => {
    const dir = buildSecrets();
    const block =
      '  key_groups:\n    - age:\n        - recipient: age1test\n          enc: recipient-envelope';
    write(dir, 'secrets/ci.yaml', withMetadata(CI_SECRETS_YAML, block));
    expect(await collectCiSecretsProblems(dir)).toEqual([]);
  });

  it('accepts unmodified SOPS 3.13 output with two age key groups', async () => {
    const dir = buildSecrets();
    write(dir, 'secrets/ci.yaml', SOPS_3_13_TWO_AGE_KEY_GROUPS);
    expect(await collectCiSecretsProblems(dir)).toEqual([]);
  });

  it.each([
    ['empty-only sources', '  key_groups:\n    - age: []\n      hc_vault: []'],
    [
      'a null sibling entry',
      '  key_groups:\n    - age:\n        - recipient: age1test\n          enc: recipient-envelope\n      hc_vault:\n        - null',
    ],
    [
      'an object sibling entry',
      '  key_groups:\n    - age:\n        - recipient: age1test\n          enc: recipient-envelope\n      hc_vault:\n        - {}',
    ],
    [
      'an incomplete non-empty sibling',
      '  key_groups:\n    - age:\n        - recipient: age1test\n          enc: recipient-envelope\n      hc_vault:\n        - vault_address: https://vault.example',
    ],
  ])('rejects a key group with %s', async (_label, block) => {
    const dir = buildSecrets();
    write(dir, 'secrets/ci.yaml', withMetadata(CI_SECRETS_YAML, block));
    expect(await collectCiSecretsProblems(dir)).toContain(
      'secrets/ci.yaml: incomplete top-level "sops" metadata; encrypt the file with SOPS before committing it',
    );
  });

  it('rejects an empty direct-source sibling', async () => {
    const dir = buildSecrets();
    const block = `${directSources[0][1]}\n  hc_vault: []`;
    write(dir, 'secrets/ci.yaml', withMetadata(CI_SECRETS_YAML, block));
    expect(await collectCiSecretsProblems(dir)).toContain(
      'secrets/ci.yaml: incomplete top-level "sops" metadata; encrypt the file with SOPS before committing it',
    );
  });
});

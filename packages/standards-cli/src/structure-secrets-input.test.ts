import { afterEach, describe, expect, it } from 'bun:test';
import { collectCiSecretsProblems } from './structure-secrets';
import {
  CI_SECRETS_YAML,
  CI_SOPS_METADATA_YAML,
  cleanupStructureTmps,
  FAKE_ENC,
  newStructureTmp,
  writeInto as write,
  writeCiSecretsPair,
} from './structure-test-support';

afterEach(cleanupStructureTmps);

const INDENTATION = /^\s*/u;
const APP_ID_LINE = /^ {8}app_id: .*$/mu;
const SOPS_METADATA = /sops:[\s\S]*$/u;
const REQUIRED_KEY_COUNT = 2;

const buildSecrets = (): string => {
  const dir = newStructureTmp('structure-secrets-input-');
  writeCiSecretsPair(dir);
  return dir;
};

const replaceScalarWithArray = (yaml: string, key: string): string =>
  yaml.replace(
    new RegExp(`^(\\s+${key}): (ENC\\[[^\\n]+)$`, 'mu'),
    (_line, prefix: string, value: string) => {
      const indentation = INDENTATION.exec(prefix)?.[0] ?? '';
      return `${prefix}:\n${indentation}    - ${value}`;
    },
  );

describe('CI secret structural identity', () => {
  it('does not accept top-level dotted keys as required nested keys', async () => {
    const dir = buildSecrets();
    write(
      dir,
      'secrets/ci.yaml',
      `"ci.broker_app.app_id": ${FAKE_ENC}\n"ci.broker_app.private_key": ${FAKE_ENC}\n${CI_SOPS_METADATA_YAML}`,
    );
    write(
      dir,
      'secrets/ci.example.yaml',
      '"ci.broker_app.app_id": placeholder\n"ci.broker_app.private_key": placeholder\n',
    );
    const problems = await collectCiSecretsProblems(dir);
    expect(problems).toContain(
      'secrets/ci.yaml: missing required key "ci.broker_app.app_id" — the synced Standards sync workflow mints a branch token with Contents write and Workflows write plus a pull request token with Contents read and Pull requests write from ci.broker_app; provision it with "bun standards creds add github --dest ci:ci.broker_app"',
    );
    expect(problems).toHaveLength(REQUIRED_KEY_COUNT);
  });

  it('reports direct-plus-nested ambiguity and the colliding plaintext value', async () => {
    const dir = buildSecrets();
    const leaked = 'PLAINTEXT_COLLISION_MUST_NOT_BE_ECHOED';
    write(
      dir,
      'secrets/ci.yaml',
      `ci:\n  "broker_app.private_key": ${leaked}\n  broker_app:\n    app_id: ${FAKE_ENC}\n    private_key: ${FAKE_ENC}\n${CI_SOPS_METADATA_YAML}`,
    );
    const problems = await collectCiSecretsProblems(dir);
    expect(problems).toContain(
      'secrets/ci.yaml: key path "ci.broker_app.private_key" is ambiguous because direct dotted keys and nested mappings collide',
    );
    expect(problems).toContain(
      'secrets/ci.yaml: value at "ci.broker_app.private_key" is not a complete SOPS-encrypted value; plaintext secret values must never be committed',
    );
    expect(problems.join('\n')).not.toContain(leaked);
  });

  it('rejects non-isomorphic mapping shapes across the two documents', async () => {
    const dir = buildSecrets();
    write(
      dir,
      'secrets/ci.example.yaml',
      '"ci.broker_app.app_id": placeholder\nci:\n  broker_app:\n    private_key: placeholder\n',
    );
    const problems = await collectCiSecretsProblems(dir);
    expect(problems).toContain(
      'secrets/ci.example.yaml: missing key "ci.broker_app.app_id" with the same mapping shape; mirror every secrets/ci.yaml key with a placeholder',
    );
    expect(problems).toContain(
      'secrets/ci.yaml: missing key "ci.broker_app.app_id" with the same mapping shape; add the secret or delete the stale key from secrets/ci.example.yaml',
    );
  });
});

describe('CI secret ciphertext and metadata shape', () => {
  it.each([
    ['a bare prefix', 'ENC['],
    ['an empty data field', 'ENC[AES256_GCM,data:,iv:aWl2,tag:dGFn,type:str]'],
    ['a truncated envelope', 'ENC[AES256_GCM,data:eA=='],
    [
      'garbage fields',
      'ENC[AES256_GCM,data:eA==,iv:aWl2,tag:dGFn,garbage:eA==,type:str]',
    ],
    [
      'trailing plaintext',
      'ENC[AES256_GCM,data:eA==,iv:aWl2,tag:dGFn,type:str]trailing',
    ],
  ])(
    'rejects %s instead of treating it as ciphertext',
    async (_label, value) => {
      const dir = buildSecrets();
      write(
        dir,
        'secrets/ci.yaml',
        CI_SECRETS_YAML.replace(APP_ID_LINE, `        app_id: ${value}`),
      );
      expect(await collectCiSecretsProblems(dir)).toContain(
        'secrets/ci.yaml: value at "ci.broker_app.app_id" is not a complete SOPS-encrypted value; plaintext secret values must never be committed',
      );
    },
  );

  it('rejects an array containing a malformed ciphertext element', async () => {
    const dir = buildSecrets();
    write(
      dir,
      'secrets/ci.yaml',
      CI_SECRETS_YAML.replace(
        APP_ID_LINE,
        `        app_id:\n            - ${FAKE_ENC}\n            - ENC[broken`,
      ),
    );
    expect(await collectCiSecretsProblems(dir)).toContain(
      'secrets/ci.yaml: value at "ci.broker_app.app_id" is not a complete SOPS-encrypted value; plaintext secret values must never be committed',
    );
  });

  it.each([
    ['empty metadata', 'sops: {}\n'],
    ['no recipient', `sops:\n  version: 3.9.0\n  mac: ${FAKE_ENC}\n`],
    ['no MAC', 'sops:\n  age: [{}]\n  version: 3.9.0\n'],
    [
      'invalid version',
      `sops:\n  age: [{}]\n  version: latest\n  mac: ${FAKE_ENC}\n`,
    ],
  ])('rejects incomplete SOPS metadata: %s', async (_label, metadata) => {
    const dir = buildSecrets();
    write(
      dir,
      'secrets/ci.yaml',
      CI_SECRETS_YAML.replace(SOPS_METADATA, metadata),
    );
    expect(await collectCiSecretsProblems(dir)).toContain(
      'secrets/ci.yaml: incomplete top-level "sops" metadata; encrypt the file with SOPS before committing it',
    );
  });

  it.each(['app_id', 'private_key'])(
    'requires workflow key %s to be an encrypted string scalar',
    async (key) => {
      const dir = buildSecrets();
      write(
        dir,
        'secrets/ci.yaml',
        replaceScalarWithArray(CI_SECRETS_YAML, key),
      );
      expect(await collectCiSecretsProblems(dir)).toContain(
        `secrets/ci.yaml: required key "ci.broker_app.${key}" must be one SOPS-encrypted string scalar because its workflow resolves it as a string`,
      );
    },
  );

  it('rejects ciphertext-looking example leaves even without metadata', async () => {
    const dir = buildSecrets();
    write(
      dir,
      'secrets/ci.example.yaml',
      CI_SECRETS_YAML.split('sops:')[0] ?? '',
    );
    expect(await collectCiSecretsProblems(dir)).toContain(
      'secrets/ci.example.yaml: value at "ci.broker_app.app_id" looks SOPS-encrypted; replace it with a plaintext placeholder',
    );
  });
});

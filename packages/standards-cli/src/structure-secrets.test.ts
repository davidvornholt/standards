import { afterEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { collectCiSecretsProblems } from './structure-secrets';
import {
  CI_EXAMPLE_YAML,
  CI_SECRETS_YAML,
  cleanupStructureTmps,
  newStructureTmp,
  writeInto as write,
  writeCiSecretsPair,
} from './structure-test-support';

afterEach(cleanupStructureTmps);

const buildSecrets = (): string => {
  const dir = newStructureTmp('structure-secrets-');
  writeCiSecretsPair(dir);
  return dir;
};
const ENC = 'ENC[AES256_GCM,data:eA==,iv:aWl2,tag:dGFn,type:str]';
const NTFY_ENC_LINE = /ntfy_topic_url: ENC\[[^\]]+\]/u;

describe('collectCiSecretsProblems', () => {
  it('accepts a mirrored SOPS-encrypted pair with the required keys', async () => {
    expect(await collectCiSecretsProblems(buildSecrets())).toEqual([]);
  });

  it('requires both files to exist', async () => {
    const dir = newStructureTmp('structure-secrets-');
    expect(await collectCiSecretsProblems(dir)).toEqual([
      'secrets/ci.yaml: must exist as a SOPS-encrypted file; the synced CI workflows read ci.ntfy_topic_url and ci.broker_app from it',
      'secrets/ci.example.yaml: must exist and mirror the key shape of secrets/ci.yaml with plaintext placeholders',
    ]);
  });

  it('reports each required key with the workflow that needs it', async () => {
    const dir = buildSecrets();
    write(dir, 'secrets/ci.yaml', `ci:\n    other: ${ENC}\nsops:\n    v: 1\n`);
    const problems = await collectCiSecretsProblems(dir);
    expect(problems).toEqual([
      'secrets/ci.yaml: missing required key "ci.ntfy_topic_url" — the synced Notify pause workflow pushes to it',
      'secrets/ci.yaml: missing required key "ci.broker_app.app_id" — the synced Standards sync workflow mints its pull request token from ci.broker_app; provision it with "bun standards creds add github --dest ci:ci.broker_app"',
      'secrets/ci.yaml: missing required key "ci.broker_app.private_key" — the synced Standards sync workflow mints its pull request token from ci.broker_app; provision it with "bun standards creds add github --dest ci:ci.broker_app"',
      'secrets/ci.example.yaml: missing key "ci.other"; mirror every secrets/ci.yaml key with a placeholder',
    ]);
  });

  it('flags a plaintext leaf by key path without echoing the value', async () => {
    const dir = buildSecrets();
    const leaked = CI_SECRETS_YAML.replace(
      NTFY_ENC_LINE,
      'ntfy_topic_url: https://ntfy.sh/oops-a-real-secret',
    );
    write(dir, 'secrets/ci.yaml', leaked);
    const problems = await collectCiSecretsProblems(dir);
    expect(problems).toEqual([
      'secrets/ci.yaml: value at "ci.ntfy_topic_url" is not SOPS-encrypted; plaintext secret values must never be committed',
    ]);
    expect(problems.join('\n')).not.toContain('oops-a-real-secret');
  });

  it('requires the SOPS metadata block on the encrypted file', async () => {
    const dir = buildSecrets();
    const withoutSops = CI_SECRETS_YAML.split('sops:')[0] ?? '';
    write(dir, 'secrets/ci.yaml', withoutSops);
    expect(await collectCiSecretsProblems(dir)).toEqual([
      'secrets/ci.yaml: missing the top-level "sops" metadata block; encrypt the file with SOPS before committing it',
    ]);
  });

  it('rejects an example that is itself SOPS-encrypted', async () => {
    const dir = buildSecrets();
    write(dir, 'secrets/ci.example.yaml', CI_SECRETS_YAML);
    expect(await collectCiSecretsProblems(dir)).toEqual([
      'secrets/ci.example.yaml: must hold plaintext placeholders, not SOPS-encrypted content',
    ]);
  });

  it('reports shape drift in both directions', async () => {
    const dir = buildSecrets();
    write(
      dir,
      'secrets/ci.yaml',
      CI_SECRETS_YAML.replace('ci:', `ci:\n    extra_token: ${ENC}`),
    );
    write(dir, 'secrets/ci.example.yaml', `${CI_EXAMPLE_YAML}  stale_key: x\n`);
    expect(await collectCiSecretsProblems(dir)).toEqual([
      'secrets/ci.example.yaml: missing key "ci.extra_token"; mirror every secrets/ci.yaml key with a placeholder',
      'secrets/ci.yaml: missing key "ci.stale_key"; add the secret or delete the stale key from secrets/ci.example.yaml',
    ]);
  });

  it('aggregates parse and file problems instead of stopping early', async () => {
    const dir = buildSecrets();
    write(dir, 'secrets/ci.yaml', 'ci: [unclosed\n');
    rmSync(join(dir, 'secrets/ci.example.yaml'));
    expect(await collectCiSecretsProblems(dir)).toEqual([
      'secrets/ci.yaml must contain valid YAML with unique mapping keys',
      'secrets/ci.example.yaml: must exist and mirror the key shape of secrets/ci.yaml with plaintext placeholders',
    ]);
  });

  it('rejects a scalar document as a non-mapping', async () => {
    const dir = buildSecrets();
    write(dir, 'secrets/ci.example.yaml', 'just a string\n');
    expect(await collectCiSecretsProblems(dir)).toEqual([
      'secrets/ci.example.yaml: must be a YAML mapping',
    ]);
  });
});

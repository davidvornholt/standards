import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listEncryptedKeys,
  listSecretsTargets,
  resolveTargetRel,
} from './creds-sops';
import { applySopsEditorChange } from './creds-sops-editor';

const dirs: Array<string> = [];
const mkConsumer = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'creds-sops-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ENCRYPTED = `ci:
    example_token: ENC[AES256_GCM,data:abc,type:str]
    nested:
        deep_key: ENC[AES256_GCM,data:def,type:str]
sops:
    version: 3.9.0
    age:
        - recipient: age1abc
`;

describe('SOPS structure reading', () => {
  it('lists dotted leaf keys of an encrypted document without decrypting', () => {
    expect(listEncryptedKeys(ENCRYPTED)).toEqual([
      'ci.example_token',
      'ci.nested.deep_key',
    ]);
  });

  it('returns null for a file without sops metadata', () => {
    expect(listEncryptedKeys('ci:\n  example: plaintext\n')).toBeNull();
    expect(listEncryptedKeys('not: [valid')).toBeNull();
  });

  it('discovers flat and host secrets targets, skipping examples', () => {
    const consumer = mkConsumer();
    mkdirSync(join(consumer, 'secrets'));
    mkdirSync(join(consumer, 'infra', 'hosts', 'prod-1'), { recursive: true });
    writeFileSync(join(consumer, 'secrets', 'ci.yaml'), ENCRYPTED);
    writeFileSync(join(consumer, 'secrets', 'ci.example.yaml'), 'ci: {}\n');
    writeFileSync(
      join(consumer, 'infra', 'hosts', 'prod-1', 'secrets.yaml'),
      ENCRYPTED,
    );
    expect(listSecretsTargets(consumer)).toEqual([
      { target: 'ci', rel: 'secrets/ci.yaml' },
      { target: 'prod-1', rel: 'infra/hosts/prod-1/secrets.yaml' },
    ]);
  });

  it('resolves target names the same way as the canonical justfile', () => {
    const consumer = mkConsumer();
    mkdirSync(join(consumer, 'secrets'));
    mkdirSync(join(consumer, 'infra', 'hosts', 'prod-1'), { recursive: true });
    writeFileSync(join(consumer, 'secrets', 'ci.yaml'), ENCRYPTED);
    expect(resolveTargetRel(consumer, 'ci')).toBe('secrets/ci.yaml');
    expect(resolveTargetRel(consumer, 'prod-1')).toBe(
      'infra/hosts/prod-1/secrets.yaml',
    );
    expect(resolveTargetRel(consumer, 'missing')).toBeNull();
  });
});

describe('SOPS editor change application', () => {
  it('sets a nested value while preserving comments and order', () => {
    const decrypted = `# CI secrets; see README.
ci:
  # replace me eventually
  example_token: old-value
  other: keep
`;
    const changed = applySopsEditorChange(
      decrypted,
      'ci.example_token',
      'new-value',
    );
    expect(changed).toContain('# CI secrets; see README.');
    expect(changed).toContain('# replace me eventually');
    expect(changed).toContain('example_token: new-value');
    expect(changed).toContain('other: keep');
    expect(changed.indexOf('example_token')).toBeLessThan(
      changed.indexOf('other:'),
    );
  });

  it('creates intermediate mappings for a new dotted path', () => {
    const changed = applySopsEditorChange(
      'ci:\n  existing: x\n',
      'ci.deploy_app.app_id',
      '42',
    );
    expect(changed).toContain('deploy_app:');
    expect(changed).toContain('app_id: "42"');
  });

  it('refuses to operate on an unparseable document', () => {
    expect(() => applySopsEditorChange('a: [broken', 'a', 'v')).toThrow(
      'did not parse',
    );
  });
});

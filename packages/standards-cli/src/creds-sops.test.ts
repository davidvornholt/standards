import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSecretsTargets, resolveTargetRel } from './creds-dest';
import {
  inspectSopsScalarDestination,
  listEncryptedKeys,
  verifySopsScalarLeaf,
} from './creds-sops';
import { applySopsEditorChanges } from './creds-sops-editor';

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
    expect(listEncryptedKeys(ENCRYPTED)).toEqual({
      keys: ['ci.example_token', 'ci.nested.deep_key'],
      ok: true,
    });
  });

  it('distinguishes missing metadata from malformed YAML', () => {
    expect(listEncryptedKeys('ci:\n  example: plaintext\n')).toMatchObject({
      ok: false,
      kind: 'missing-sops-metadata',
    });
    expect(listEncryptedKeys('not: [valid')).toMatchObject({
      ok: false,
      kind: 'malformed-yaml',
    });
  });

  it('rejects ambiguous literal-dot keys and arrays', () => {
    const dotted = `ci:\n  "nested.token": encrypted\nsops: {}\n`;
    const array = 'ci:\n  tokens: [encrypted]\nsops: {}\n';
    expect(listEncryptedKeys(dotted)).toMatchObject({
      ok: false,
      kind: 'unsupported-shape',
    });
    expect(listEncryptedKeys(array)).toMatchObject({
      ok: false,
      kind: 'unsupported-shape',
    });
  });

  it('discovers flat and host secrets targets, skipping examples', () => {
    const consumer = mkConsumer();
    mkdirSync(join(consumer, 'secrets'));
    mkdirSync(join(consumer, 'infra', 'hosts', 'prod-1'), { recursive: true });
    writeFileSync(join(consumer, 'secrets', 'ci.yaml'), ENCRYPTED);
    writeFileSync(
      join(consumer, 'infra', 'hosts', 'prod-1', 'secrets.yaml'),
      ENCRYPTED,
    );
    writeFileSync(join(consumer, 'secrets', 'ci.example.yaml'), 'ci: {}\n');
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
    writeFileSync(
      join(consumer, 'infra', 'hosts', 'prod-1', 'secrets.yaml'),
      ENCRYPTED,
    );
    expect(resolveTargetRel(consumer, 'ci')).toBe('secrets/ci.yaml');
    expect(resolveTargetRel(consumer, 'prod-1')).toBe(
      'infra/hosts/prod-1/secrets.yaml',
    );
    expect(resolveTargetRel(consumer, 'missing')).toBeNull();
  });

  it('preflights scalar leaves without returning their values', async () => {
    const consumer = mkConsumer();
    mkdirSync(join(consumer, 'secrets'));
    writeFileSync(join(consumer, 'secrets', 'ci.yaml'), ENCRYPTED);
    expect(
      await inspectSopsScalarDestination(
        consumer,
        'secrets/ci.yaml',
        'ci.example_token',
      ),
    ).toEqual({ ok: true, state: 'scalar' });
    expect(
      await inspectSopsScalarDestination(
        consumer,
        'secrets/ci.yaml',
        'ci.missing',
      ),
    ).toEqual({ ok: true, state: 'absent' });
    expect(
      await inspectSopsScalarDestination(
        consumer,
        'secrets/ci.yaml',
        'ci.nested',
      ),
    ).toMatchObject({ ok: false, kind: 'collection' });
    expect(
      await verifySopsScalarLeaf(
        consumer,
        'secrets/ci.yaml',
        'ci.example_token',
      ),
    ).toEqual({ ok: true });
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
    const changed = applySopsEditorChanges(decrypted, [
      { path: 'ci.example_token', value: 'new-value' },
    ]);
    expect(changed).toContain('# CI secrets; see README.');
    expect(changed).toContain('# replace me eventually');
    expect(changed).toContain('example_token: new-value');
    expect(changed).toContain('other: keep');
    expect(changed.indexOf('example_token')).toBeLessThan(
      changed.indexOf('other:'),
    );
  });

  it('creates intermediate mappings for a new dotted path', () => {
    const changed = applySopsEditorChanges('ci:\n  existing: x\n', [
      { path: 'ci.deploy_app.app_id', value: '42' },
    ]);
    expect(changed).toContain('deploy_app:');
    expect(changed).toContain('app_id: "42"');
  });

  it('refuses to operate on an unparseable document', () => {
    expect(() =>
      applySopsEditorChanges('a: [broken', [{ path: 'a', value: 'v' }]),
    ).toThrow('malformed YAML');
  });

  it('updates a GitHub credential pair in one editor transaction', () => {
    const changed = applySopsEditorChanges(
      'ci:\n  app:\n    app_id: old-id\n    private_key: old-key\n',
      [
        { path: 'ci.app.app_id', value: 'new-id' },
        { path: 'ci.app.private_key', value: 'new-key' },
      ],
    );
    expect(changed).toContain('app_id: new-id');
    expect(changed).toContain('private_key: new-key');
  });

  it('rejects the complete batch before replacing a mapping', () => {
    const original =
      'ci:\n  app:\n    app_id: old-id\n    private_key: old-key\n  nested:\n    keep: value\n';
    expect(() =>
      applySopsEditorChanges(original, [
        { path: 'ci.app.app_id', value: 'new-id' },
        { path: 'ci.nested', value: 'replacement' },
      ]),
    ).toThrow('names a mapping');
    expect(original).toContain('app_id: old-id');
    expect(original).toContain('private_key: old-key');
  });
});

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
// biome-ignore lint/performance/noNamespaceImport: spyOn makes the example write fail the same way for every user, root included.
import * as fs from 'node:fs';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addExamplePlaceholders, exampleRelFor } from './creds-example';
import { setSopsValues } from './creds-sops';
// biome-ignore lint/performance/noNamespaceImport: spyOn replaces the SOPS process so the test needs no sops binary or key.
import * as exec from './sops-exec';

const dirs: Array<string> = [];
afterEach(() => {
  mock.restore();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const EXAMPLE = `# Plaintext shape only.
ci:
  # The broker App.
  broker_app:
    app_id: replace-with-the-broker-github-app-id
`;

describe('example placeholders', () => {
  it('names the example beside an encrypted secrets file', () => {
    expect(exampleRelFor('secrets/ci.yaml')).toBe('secrets/ci.example.yaml');
    expect(exampleRelFor('infra/hosts/prod/secrets.yaml')).toBe(
      'infra/hosts/prod/secrets.example.yaml',
    );
    expect(exampleRelFor('secrets/ci.example.yaml')).toBeNull();
  });

  it('adds a missing key and keeps comments and existing values', () => {
    expect(
      addExamplePlaceholders(EXAMPLE, [
        'ci.cloudflare_dns_token',
        'ci.broker_app.app_id',
      ]),
    ).toBe(`# Plaintext shape only.
ci:
  # The broker App.
  broker_app:
    app_id: replace-with-the-broker-github-app-id
  cloudflare_dns_token: replace-with-cloudflare-dns-token
`);
  });

  it('creates missing parent mappings', () => {
    expect(
      addExamplePlaceholders(EXAMPLE, [
        'assets.screenshots_rw.access_key_id',
        'assets.screenshots_rw.secret_access_key',
      ]),
    ).toContain(`assets:
  screenshots_rw:
    access_key_id: replace-with-access-key-id
    secret_access_key: replace-with-secret-access-key
`);
    expect(addExamplePlaceholders('', ['ci.token'])).toBe(
      'ci:\n  token: replace-with-token\n',
    );
  });

  it('changes nothing when every key exists, a scalar is in the way, the YAML is invalid, or it uses aliases', () => {
    expect(
      addExamplePlaceholders(EXAMPLE, ['ci.broker_app.app_id']),
    ).toBeNull();
    expect(
      addExamplePlaceholders(EXAMPLE, ['ci.broker_app.app_id.nested']),
    ).toBeNull();
    expect(addExamplePlaceholders('ci: [unclosed', ['ci.token'])).toBeNull();
    expect(
      addExamplePlaceholders(
        'base: &base\n  service:\n    old: documented\nci:\n  <<: *base\n',
        ['ci.service.token'],
      ),
    ).toBeNull();
    expect(
      addExamplePlaceholders('base: &base\n  old: documented\nci: *base\n', [
        'other.token',
      ]),
    ).toBeNull();
    expect(
      addExamplePlaceholders(
        'ci:\n  <<:\n    service:\n      old: documented\n',
        ['ci.service.token'],
      ),
    ).toBeNull();
  });
});

describe('setSopsValues', () => {
  const consumerWith = (example: string | null): string => {
    const consumer = mkdtempSync(join(tmpdir(), 'creds-example-'));
    dirs.push(consumer);
    mkdirSync(join(consumer, 'secrets'));
    writeFileSync(join(consumer, 'secrets/ci.yaml'), 'ci: {}\nsops: {}\n');
    if (example !== null) {
      writeFileSync(join(consumer, 'secrets/ci.example.yaml'), example);
    }
    return consumer;
  };

  const sopsExits = (status: number): void => {
    spyOn(exec, 'runSops').mockImplementation(() => ({
      status,
      stdout: '',
      stderr: status === 0 ? '' : 'failed',
      errorMessage: null,
    }));
  };

  it('mirrors written keys into the example after a successful write', () => {
    const consumer = consumerWith(EXAMPLE);
    sopsExits(0);

    expect(
      setSopsValues(consumer, 'secrets/ci.yaml', [
        { path: 'ci.cloudflare_dns_token', value: 'secret-value' },
      ]),
    ).toEqual({ ok: true });
    const example = readFileSync(
      join(consumer, 'secrets/ci.example.yaml'),
      'utf8',
    );
    expect(example).toContain(
      'cloudflare_dns_token: replace-with-cloudflare-dns-token',
    );
    expect(example).not.toContain('secret-value');
  });

  it('leaves the example alone when the write fails and creates none', () => {
    const consumer = consumerWith(EXAMPLE);
    sopsExits(1);

    expect(
      setSopsValues(consumer, 'secrets/ci.yaml', [
        { path: 'ci.cloudflare_dns_token', value: 'secret-value' },
      ]).ok,
    ).toBe(false);
    expect(
      readFileSync(join(consumer, 'secrets/ci.example.yaml'), 'utf8'),
    ).toBe(EXAMPLE);

    const withoutExample = consumerWith(null);
    sopsExits(0);
    expect(
      setSopsValues(withoutExample, 'secrets/ci.yaml', [
        { path: 'ci.token', value: 'secret-value' },
      ]),
    ).toEqual({ ok: true });
    expect(() =>
      readFileSync(join(withoutExample, 'secrets/ci.example.yaml')),
    ).toThrow();
  });

  it('still reports the encrypted write as done when the example cannot be written', () => {
    const consumer = consumerWith(EXAMPLE);
    spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), {
        code: 'EACCES',
      });
    });
    sopsExits(0);
    const errors: Array<string> = [];
    spyOn(console, 'error').mockImplementation((...values) => {
      errors.push(values.join(' '));
    });

    expect(
      setSopsValues(consumer, 'secrets/ci.yaml', [
        { path: 'ci.cloudflare_dns_token', value: 'secret-value' },
      ]),
    ).toEqual({ ok: true });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(
      'standards creds: warning: could not add placeholders for ci.cloudflare_dns_token to secrets/ci.example.yaml',
    );
    expect(errors[0]).not.toContain('secret-value');
  });
});

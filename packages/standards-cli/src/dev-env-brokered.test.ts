import { describe, expect, it } from 'bun:test';
import { parseDevEnvDocument } from './dev-env-document';

const reference = {
  brokeredS3: 'r2-dev',
  key: 'r2.dev_rw',
  part: 'access_key_id',
} as const;

describe('brokered S3 pair references in dev env documents', () => {
  it('parses a reference value in a configuration layer', () => {
    const document = parseDevEnvDocument(
      { apps: { web: { S3_ACCESS_KEY_ID: reference, PORT: '3000' } } },
      'config/dev.yaml',
      'allowed',
    );

    expect(document.problems).toEqual([]);
    expect(document.targets[0]?.env).toEqual({
      S3_ACCESS_KEY_ID: reference,
      PORT: '3000',
    });
    expect(document.targets[0]?.declaredKeys).toEqual(
      new Set(['S3_ACCESS_KEY_ID', 'PORT']),
    );
  });

  it('rejects a reference declared in the secrets layer', () => {
    const document = parseDevEnvDocument(
      { apps: { web: { S3_ACCESS_KEY_ID: reference } } },
      'secrets/dev.yaml',
      'forbidden',
    );

    expect(document.problems).toEqual([
      'secrets/dev.yaml "apps.web".S3_ACCESS_KEY_ID is a brokered S3 pair reference; references are configuration and belong in config/dev.yaml or config/dev.local.yaml, not the secrets layer',
    ]);
    expect(document.targets[0]?.env).toEqual({});
  });

  it('gathers every malformed reference field in one pass', () => {
    const document = parseDevEnvDocument(
      {
        apps: {
          web: {
            S3_ACCESS_KEY_ID: {
              brokeredS3: '',
              key: 'not..a..key',
              part: 'token',
              extra: true,
            },
          },
        },
      },
      'config/dev.yaml',
      'allowed',
    );

    expect(document.problems).toEqual([
      'config/dev.yaml "apps.web".S3_ACCESS_KEY_ID brokered S3 pair reference has unknown property "extra"; allowed properties are brokeredS3, key, and part',
      'config/dev.yaml "apps.web".S3_ACCESS_KEY_ID brokered S3 pair reference needs a non-empty "brokeredS3" secrets target name',
      'config/dev.yaml "apps.web".S3_ACCESS_KEY_ID brokered S3 pair reference needs a "key" naming the pair\'s dotted SOPS key',
      'config/dev.yaml "apps.web".S3_ACCESS_KEY_ID brokered S3 pair reference needs a "part" of either "access_key_id" or "secret_access_key"',
    ]);
  });

  it('names both accepted value shapes when a configuration value is neither', () => {
    const document = parseDevEnvDocument(
      { apps: { web: { PORT: 3000 } } },
      'config/dev.yaml',
      'allowed',
    );

    expect(document.problems).toEqual([
      'config/dev.yaml "apps.web".PORT must be a string value or a brokered S3 pair reference',
    ]);
  });
});

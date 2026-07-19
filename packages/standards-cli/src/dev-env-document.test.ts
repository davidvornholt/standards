import { describe, expect, it } from 'bun:test';
import { parseDevEnvDocument } from './dev-env-document';

const INVALID_ENTRY_COUNT = 9;

describe('dev env document', () => {
  it('parses workspace-group keyed env values', () => {
    const document = parseDevEnvDocument(
      {
        apps: { web: { DATABASE_URL: 'postgres://dev', AUTH_SECRET: 's' } },
        packages: { db: { DATABASE_URL: 'postgres://dev' } },
      },
      'secrets/dev.yaml',
    );

    expect(document.problems).toEqual([]);
    expect(document.targets).toEqual([
      {
        group: 'apps',
        workspace: 'web',
        env: { DATABASE_URL: 'postgres://dev', AUTH_SECRET: 's' },
      },
      {
        group: 'packages',
        workspace: 'db',
        env: { DATABASE_URL: 'postgres://dev' },
      },
    ]);
  });

  it('rejects a document that is not an object', () => {
    expect(parseDevEnvDocument(['apps'], 'secrets/dev.yaml').problems).toEqual([
      'secrets/dev.yaml must decrypt to a YAML object',
    ]);
  });

  it('gathers every problem instead of failing on the first', () => {
    const document = parseDevEnvDocument(
      {
        ci: { token: 'x' },
        apps: { web: { PORT: 3000, NAME: 'ok' }, broken: 'nope' },
        packages: 'nope',
      },
      'secrets/dev.yaml',
    );

    expect(document.problems).toEqual([
      'secrets/dev.yaml top-level key "ci" must be "apps" or "packages"',
      'secrets/dev.yaml "apps.web".PORT must be a string value',
      'secrets/dev.yaml "apps.broken" must map env keys to string values',
      'secrets/dev.yaml "packages" must map workspace names to env objects',
    ]);
    expect(document.targets).toEqual([
      { group: 'apps', workspace: 'web', env: { NAME: 'ok' } },
    ]);
  });

  it('rejects path-like workspace names and non-portable env names together', () => {
    const document = parseDevEnvDocument(
      {
        apps: {
          '..': { 'BAD=NAME': 42 },
          'nested/name': 'not-an-env-object',
          '/absolute': { OK: 'yes' },
          'with space': { OK: 'yes' },
          web: { 'BAD=NAME': 'x', 'BAD\nINJECTED': 'x', _VALID: '' },
        },
      },
      'secrets/dev.yaml',
    );

    expect(document.problems).toHaveLength(INVALID_ENTRY_COUNT);
    expect(document.problems.join('\n')).toContain('apps...');
    expect(document.problems.join('\n')).toContain('apps.nested/name');
    expect(document.problems.join('\n')).toContain('apps./absolute');
    expect(document.problems.join('\n')).toContain('apps.with space');
    expect(document.problems.join('\n')).toContain('BAD=NAME');
    expect(document.problems.join('\n')).toContain('BAD\\nINJECTED');
    expect(document.problems.join('\n')).toContain(
      '"apps.nested/name" must map env keys to string values',
    );
    expect(document.problems.join('\n')).toContain(
      '"apps...".BAD=NAME must be a string value',
    );
    expect(document.targets).toEqual([
      { group: 'apps', workspace: 'web', env: { _VALID: '' } },
    ]);
  });

  it('rejects values Bun dotenv cannot represent without changing bytes', () => {
    const document = parseDevEnvDocument(
      { apps: { web: { VALID: '\\\n', INVALID: '\\\r' } } },
      'secrets/dev.yaml',
    );

    expect(document.problems).toEqual([
      'secrets/dev.yaml "apps.web".INVALID cannot be represented losslessly in Bun dotenv syntax',
    ]);
    expect(document.targets).toEqual([
      { group: 'apps', workspace: 'web', env: { VALID: '\\\n' } },
    ]);
  });
});

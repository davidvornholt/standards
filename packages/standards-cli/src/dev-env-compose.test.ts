import { describe, expect, it } from 'bun:test';
import { composeDevEnv, type DevEnvLayer } from './dev-env-compose';
import { parseDevEnvDocument } from './dev-env-document';

const layer = (source: string, raw: unknown): DevEnvLayer => ({
  source,
  document: parseDevEnvDocument(raw, source),
});

describe('dev env composition', () => {
  it('overrides per key: config, then secrets, then local', () => {
    const composed = composeDevEnv(
      layer('config/dev.yaml', {
        apps: { web: { PORT: '3000', S3_ENDPOINT: 'http://127.0.0.1:9000' } },
      }),
      layer('secrets/dev.yaml', {
        apps: { web: { AUTH_SECRET: 'shared-secret' } },
      }),
      layer('config/dev.local.yaml', {
        apps: {
          web: { S3_ENDPOINT: 'https://s3.example.test', AUTH_SECRET: 'mine' },
        },
      }),
    );

    expect(composed.problems).toEqual([]);
    expect(composed.targets).toEqual([
      {
        group: 'apps',
        workspace: 'web',
        env: {
          PORT: '3000',
          S3_ENDPOINT: 'https://s3.example.test',
          AUTH_SECRET: 'mine',
        },
        sources: [
          'config/dev.yaml',
          'secrets/dev.yaml',
          'config/dev.local.yaml',
        ],
      },
    ]);
  });

  it('unions workspaces across layers and sorts targets', () => {
    const composed = composeDevEnv(
      layer('config/dev.yaml', { packages: { db: { PGPORT: '5432' } } }),
      layer('secrets/dev.yaml', { apps: { web: { AUTH_SECRET: 's' } } }),
      layer('config/dev.local.yaml', { apps: { admin: { PORT: '4001' } } }),
    );

    expect(composed.problems).toEqual([]);
    expect(
      composed.targets.map((target) => [
        `${target.group}.${target.workspace}`,
        target.sources,
      ]),
    ).toEqual([
      ['apps.admin', ['config/dev.local.yaml']],
      ['apps.web', ['secrets/dev.yaml']],
      ['packages.db', ['config/dev.yaml']],
    ]);
  });

  it('rejects a key declared as both configuration and a secret', () => {
    const composed = composeDevEnv(
      layer('config/dev.yaml', {
        apps: { web: { DATABASE_URL: 'postgresql://dev' } },
      }),
      layer('secrets/dev.yaml', {
        apps: { web: { DATABASE_URL: 'postgresql://real' } },
      }),
      null,
    );

    expect(composed.problems).toEqual([
      'apps.web.DATABASE_URL is declared in both config/dev.yaml and secrets/dev.yaml; a value is either configuration or a secret, so keep it in exactly one',
    ]);
  });

  it('does not treat a local override of a secret as an overlap', () => {
    const composed = composeDevEnv(
      null,
      layer('secrets/dev.yaml', { apps: { web: { AUTH_SECRET: 'shared' } } }),
      layer('config/dev.local.yaml', {
        apps: { web: { AUTH_SECRET: 'mine' } },
      }),
    );

    expect(composed.problems).toEqual([]);
    expect(composed.targets[0]?.env).toEqual({ AUTH_SECRET: 'mine' });
  });

  it('gathers document problems from every layer', () => {
    const composed = composeDevEnv(
      layer('config/dev.yaml', { infra: {} }),
      layer('secrets/dev.yaml', { apps: { web: { OK: 'yes' } } }),
      layer('config/dev.local.yaml', { apps: { web: { 'bad key': 'x' } } }),
    );

    expect(composed.problems).toEqual([
      'config/dev.yaml top-level key "infra" must be "apps" or "packages"',
      'config/dev.local.yaml "apps.web" env key "bad key" must be a portable environment variable name',
    ]);
  });
});

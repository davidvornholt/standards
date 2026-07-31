import { describe, expect, it } from 'bun:test';
import { resolveBrokeredReferences } from './dev-env-brokered-resolve';
import { composeDevEnv, type DevEnvLayer } from './dev-env-compose';
import { parseDevEnvDocument } from './dev-env-document';
import { renderDotenv } from './dev-env-dotenv';

const layer = (source: string, raw: unknown): DevEnvLayer => ({
  source,
  document: parseDevEnvDocument(
    raw,
    source,
    source === 'secrets/dev.yaml' ? 'secrets' : 'configuration',
  ),
});

const PORTABLE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const INVALID_ENV_VALUE = 123;
const PROTOTYPE_ENV_NAMES = Object.getOwnPropertyNames(Object.prototype).filter(
  (key) => PORTABLE_ENV_NAME.test(key),
);

const prototypeEnv = (): Record<string, string> =>
  Object.fromEntries(
    PROTOTYPE_ENV_NAMES.map((key, index) => [key, `value-${index}`]),
  );

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
      layer('secrets/dev.yaml', {
        apps: { web: { AUTH_SECRET: 'shared' } },
      }),
      layer('config/dev.local.yaml', {
        apps: { web: { AUTH_SECRET: 'mine' } },
      }),
    );

    expect(composed.problems).toEqual([]);
    expect(composed.targets[0]?.env).toEqual({ AUTH_SECRET: 'mine' });
  });
});

describe('dev env prototype names', () => {
  it('composes every portable Object.prototype name without false overlaps', () => {
    const composed = composeDevEnv(
      layer('config/dev.yaml', { apps: { web: prototypeEnv() } }),
      layer('secrets/dev.yaml', { apps: { web: { TOKEN: 'secret' } } }),
      null,
    );

    expect(composed.problems).toEqual([]);
    expect(Object.getPrototypeOf(composed.targets[0]?.env)).toBeNull();
    for (const key of PROTOTYPE_ENV_NAMES) {
      expect(Object.hasOwn(composed.targets[0]?.env ?? {}, key)).toBeTrue();
    }
  });

  for (const lateLayer of ['secret', 'local'] as const) {
    it(`renders later-layer prototype names exactly once from ${lateLayer}`, () => {
      const config = layer('config/dev.yaml', {
        apps: { web: { PORT: '3000' } },
      });
      const secrets = layer('secrets/dev.yaml', {
        apps: { web: lateLayer === 'secret' ? prototypeEnv() : {} },
      });
      const local =
        lateLayer === 'local'
          ? layer('config/dev.local.yaml', {
              apps: { web: prototypeEnv() },
            })
          : null;
      const composed = composeDevEnv(config, secrets, local);
      const resolved = resolveBrokeredReferences(
        '.',
        composed.targets,
        composed.brokeredReferences,
      );
      const [target] = resolved.targets;

      expect(composed.problems).toEqual([]);
      expect(resolved.problems).toEqual([]);
      expect(target).toBeDefined();
      const rendered = renderDotenv(
        'apps.web',
        target?.sources ?? [],
        target?.env ?? {},
      );
      for (const key of PROTOTYPE_ENV_NAMES) {
        expect(
          rendered.split('\n').filter((line) => line.startsWith(`${key}=`)),
        ).toHaveLength(1);
      }
    });
  }
});

describe('dev env validation', () => {
  it.each([
    ['non-string config', INVALID_ENV_VALUE, 'secret', 1],
    ['non-string secret', 'configured', INVALID_ENV_VALUE, 1],
    ['both non-string', INVALID_ENV_VALUE, false, 2],
    ['both unrenderable', '\\\r', '\\\r', 2],
  ] as const)('reports tracked ownership with %s values', (_label, configValue, secretValue, valueProblemCount) => {
    const composed = composeDevEnv(
      layer('config/dev.yaml', {
        apps: { web: { DATABASE_URL: configValue } },
      }),
      layer('secrets/dev.yaml', {
        apps: { web: { DATABASE_URL: secretValue } },
      }),
      null,
    );

    expect(composed.problems).toHaveLength(valueProblemCount + 1);
    expect(composed.problems.at(-1)).toBe(
      'apps.web.DATABASE_URL is declared in both config/dev.yaml and secrets/dev.yaml; a value is either configuration or a secret, so keep it in exactly one',
    );
  });
});

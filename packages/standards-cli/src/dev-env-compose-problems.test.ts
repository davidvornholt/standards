import { expect, it } from 'bun:test';
import { composeDevEnv } from './dev-env-compose';
import { parseDevEnvDocument } from './dev-env-document';

const VALID_ENV_KEY = 'OK';

const layer = (source: string, raw: unknown) => ({
  source,
  document: parseDevEnvDocument(
    raw,
    source,
    source === 'secrets/dev.yaml' ? 'secrets' : 'configuration',
  ),
});

it('gathers document problems from every layer', () => {
  const composed = composeDevEnv(
    layer('config/dev.yaml', { infra: {} }),
    layer('secrets/dev.yaml', {
      apps: { web: { [VALID_ENV_KEY]: 'yes' } },
    }),
    layer('config/dev.local.yaml', {
      apps: { web: { 'bad key': 'x' } },
    }),
  );

  expect(composed.problems).toEqual([
    'config/dev.yaml top-level key "infra" must be "apps" or "packages"',
    'config/dev.local.yaml "apps.web" env key "bad key" must be a portable environment variable name',
  ]);
});

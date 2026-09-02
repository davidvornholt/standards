import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const tmps: Array<string> = [];
export const cleanupStructureTmps = (): void => {
  for (const dir of tmps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
};
export const newStructureTmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(dir);
  return dir;
};
export const writeInto = (root: string, rel: string, content: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
};

export const CANONICAL_SCRIPTS = {
  'check-types': 'tsc --noEmit',
  lint: 'biome check --error-on-warnings .',
  'lint:fix': 'biome check --write --error-on-warnings .',
  test: 'bun test',
};
export const TSCONFIG =
  '{ "extends": "@davidvornholt/typescript-config/base" }\n';

const fakeEnc = (data: string): string =>
  `ENC[AES256_GCM,data:${data},iv:aWl2,tag:dGFn,type:str]`;
export const FAKE_ENC = fakeEnc('eA==');
export const CI_SOPS_METADATA_YAML = [
  'sops:',
  '    age:',
  '        - recipient: age1test',
  '          enc: test-recipient-envelope',
  '    version: 3.9.0',
  `    mac: ${fakeEnc('bWFj')}`,
  '',
].join('\n');
// The shape every consumer's encrypted CI secrets file must carry: the leaf
// keys stay plaintext under SOPS, values are opaque ciphertext.
export const CI_SECRETS_YAML = [
  'ci:',
  `    ntfy_topic_url: ${fakeEnc('bnRmeQ==')}`,
  '    broker_app:',
  `        app_id: ${fakeEnc('YXBw')}`,
  `        private_key: ${fakeEnc('a2V5')}`,
  CI_SOPS_METADATA_YAML,
].join('\n');
export const CI_EXAMPLE_YAML = [
  'ci:',
  '  ntfy_topic_url: https://ntfy.sh/replace-with-a-random-unguessable-topic',
  '  broker_app:',
  '    app_id: replace-with-the-broker-github-app-id',
  '    private_key: replace-with-the-broker-github-app-private-key',
  '',
].join('\n');
export const writeCiSecretsPair = (root: string): void => {
  writeInto(root, 'secrets/ci.yaml', CI_SECRETS_YAML);
  writeInto(root, 'secrets/ci.example.yaml', CI_EXAMPLE_YAML);
};

export const consumerRootManifest = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  name: 'app',
  version: '0.0.0',
  workspaces: ['apps/*', 'packages/*'],
  scripts: {
    standards: 'standards',
    check:
      'standards check && turbo run lint check-types test build test:a11y --output-logs=errors-only',
    'check:fix':
      'standards check && turbo run lint:fix check-types test build test:a11y --output-logs=errors-only',
  },
  ...overrides,
});

// A consumer with one app and one package, both canonical, no a11y suite.
export const buildConsumer = (
  root: Record<string, unknown> = consumerRootManifest(),
): string => {
  const consumer = newStructureTmp('structure-');
  writeInto(consumer, 'package.json', JSON.stringify(root));
  writeInto(
    consumer,
    'sync-standards.json',
    JSON.stringify({
      upstream: 'github:davidvornholt/standards',
      seedDir: 'template',
      paths: ['sync-standards.json', 'AGENTS.md'],
    }),
  );
  writeInto(
    consumer,
    'apps/web/package.json',
    JSON.stringify({
      name: '@repo/web',
      version: '0.0.0',
      scripts: CANONICAL_SCRIPTS,
      dependencies: { '@repo/ui': 'workspace:*' },
    }),
  );
  writeInto(consumer, 'apps/web/tsconfig.json', TSCONFIG);
  writeInto(consumer, 'apps/web/README.md', '# web\n\nNo configuration.\n');
  writeInto(
    consumer,
    'packages/ui/package.json',
    JSON.stringify({
      name: '@repo/ui',
      version: '0.0.0',
      exports: { './button': './src/button.tsx' },
      scripts: CANONICAL_SCRIPTS,
    }),
  );
  writeInto(consumer, 'packages/ui/tsconfig.json', TSCONFIG);
  writeInto(consumer, 'packages/ui/README.md', '# ui\n\nNo configuration.\n');
  writeCiSecretsPair(consumer);
  return consumer;
};

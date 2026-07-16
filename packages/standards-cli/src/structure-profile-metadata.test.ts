import { describe, expect, it } from 'bun:test';
import {
  inspectVersionAndExports,
  PUBLISHED_CLI_WORKSPACE,
} from './structure-profile';

const baseManifest = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  name: '@davidvornholt/standards',
  version: '0.8.0',
  bin: { standards: 'src/cli.ts' },
  ...overrides,
});
const inspect = (manifest: Record<string, unknown>): ReadonlyArray<string> =>
  inspectVersionAndExports('source', PUBLISHED_CLI_WORKSPACE, manifest);

describe('published CLI source-profile metadata', () => {
  it('accepts the exact published bin-only package metadata', () => {
    expect(inspect(baseManifest())).toEqual([]);
  });

  it('pins the published CLI name, release version, and bin', () => {
    expect(
      inspect(
        baseManifest({
          name: '@repo/cli',
          version: '0.0.0',
          bin: undefined,
        }),
      ),
    ).toEqual([
      'packages/standards-cli: published CLI package name must be "@davidvornholt/standards"',
      'packages/standards-cli: published CLI version must be a stable release SemVer, not "0.0.0"',
      'packages/standards-cli: published CLI bin must be exactly { "standards": "src/cli.ts" }',
    ]);
  });

  it.each([
    ['empty', {}],
    ['empty target', { standards: '' }],
    ['wrong target', { standards: 'dist/cli.js' }],
    ['extra target', { standards: 'src/cli.ts', helper: 'src/helper.ts' }],
    ['non-object', 'src/cli.ts'],
  ])('rejects a malformed published CLI bin: %s', (_label, bin) => {
    expect(inspect(baseManifest({ bin }))).toEqual([
      'packages/standards-cli: published CLI bin must be exactly { "standards": "src/cli.ts" }',
    ]);
  });

  it('rejects private or exported published CLI metadata', () => {
    expect(
      inspect(
        baseManifest({
          private: true,
          exports: { '.': './src/cli.ts' },
        }),
      ),
    ).toEqual([
      'packages/standards-cli: published CLI must not be private',
      'packages/standards-cli: published CLI must be bin-only and must not define "exports"',
    ]);
  });

  it.each([
    '1.0.0-rc.1',
    '01.2.3',
    1,
  ])('rejects a non-release published CLI version %#', (version) => {
    expect(inspect(baseManifest({ version }))).toEqual([
      'packages/standards-cli: published CLI version must be a stable release SemVer, not "0.0.0"',
    ]);
  });
});

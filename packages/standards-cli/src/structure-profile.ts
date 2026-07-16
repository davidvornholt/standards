import { isRecord } from './github-settings';

// Structure validation profiles. `consumer` is the contract every downstream
// repo satisfies. `source` is the standards template repository itself, which
// is deliberately not a consumer: its root gate runs the local CLI instead of
// a recursive `standards check`, and it publishes the CLI workspace as a
// released bin-only package. Pinning those exceptions here keeps them from
// drifting silently while the normal quality gate stays green.
export type StructureProfile = 'consumer' | 'source';

const CONSUMER_CHECK = 'turbo run lint check-types test build test:a11y';
const CONSUMER_CHECK_FIX =
  'turbo run lint:fix check-types test build test:a11y';
const ROOT_A11Y = 'turbo run test:a11y';

export const PUBLISHED_CLI_WORKSPACE = 'packages/standards-cli';
const PUBLISHED_CLI_PACKAGE = '@davidvornholt/standards';
const SOURCE_CLI = `bun ${PUBLISHED_CLI_WORKSPACE}/src/cli.ts`;
const RELEASE_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

const SOURCE_ROOT_EXPECTATIONS: ReadonlyArray<readonly [string, string]> = [
  ['standards', SOURCE_CLI],
  ['check', `${SOURCE_CLI} structure --profile source`],
  ['check', `${SOURCE_CLI} github --check`],
  ['check', 'turbo run lint check-types test'],
  ['check:fix', `${SOURCE_CLI} structure --profile source`],
  ['check:fix', `${SOURCE_CLI} github --check`],
  ['check:fix', 'turbo run lint:fix check-types test'],
];

export const rootScriptExpectations = (
  profile: StructureProfile,
  requireA11y: boolean,
): ReadonlyArray<readonly [string, string]> => [
  ...(profile === 'source'
    ? SOURCE_ROOT_EXPECTATIONS
    : [
        ['check', CONSUMER_CHECK] as const,
        ['check:fix', CONSUMER_CHECK_FIX] as const,
      ]),
  ...(requireA11y ? [['test:a11y', ROOT_A11Y] as const] : []),
];

// The published CLI ships as a released bin-only package: it carries a release
// SemVer instead of the internal "0.0.0" and exposes its public API through
// "bin" instead of "exports". Everything else follows the normal rules.
const inspectPublishedCli = (
  manifest: Record<string, unknown>,
): ReadonlyArray<string> => [
  ...(manifest.name === PUBLISHED_CLI_PACKAGE
    ? []
    : [
        `${PUBLISHED_CLI_WORKSPACE}: published CLI package name must be "${PUBLISHED_CLI_PACKAGE}"`,
      ]),
  ...(typeof manifest.version === 'string' &&
  manifest.version !== '0.0.0' &&
  RELEASE_SEMVER.test(manifest.version)
    ? []
    : [
        `${PUBLISHED_CLI_WORKSPACE}: published CLI version must be a stable release SemVer, not "0.0.0"`,
      ]),
  ...(isRecord(manifest.bin) && typeof manifest.bin.standards === 'string'
    ? []
    : [
        `${PUBLISHED_CLI_WORKSPACE}: published CLI must expose the "standards" bin`,
      ]),
];

export const inspectVersionAndExports = (
  profile: StructureProfile,
  rel: string,
  manifest: Record<string, unknown>,
): ReadonlyArray<string> => {
  if (profile === 'source' && rel === PUBLISHED_CLI_WORKSPACE) {
    return inspectPublishedCli(manifest);
  }
  return [
    ...(manifest.version === '0.0.0'
      ? []
      : [`${rel}: internal workspace version must be "0.0.0"`]),
    ...(rel.startsWith('packages/') && manifest.exports === undefined
      ? [`${rel}: package must define its public API with "exports"`]
      : []),
  ];
};

// The source profile only means anything in the repository that owns and
// publishes the CLI; failing loudly when that workspace is absent keeps the
// profile from being applied to the wrong repository shape.
export const missingPublishedCliProblems = (
  profile: StructureProfile,
  workspaces: ReadonlyArray<{ readonly rel: string }>,
): ReadonlyArray<string> =>
  profile === 'source' &&
  !workspaces.some((ws) => ws.rel === PUBLISHED_CLI_WORKSPACE)
    ? [
        `${PUBLISHED_CLI_WORKSPACE}: the source profile requires the published CLI workspace`,
      ]
    : [];

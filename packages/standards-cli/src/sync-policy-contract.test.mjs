import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  DEFAULT_SYNC_POLICY,
  inspectSyncPolicy,
  SYNC_POLICY_FILE,
} from './sync-policy.ts';

const directories = [];
const consumerPackageText = (version) =>
  JSON.stringify({
    devDependencies: { '@davidvornholt/standards': version },
  });
const sourceRootText = (overrides = {}) =>
  JSON.stringify({
    name: 'standards',
    private: true,
    workspaces: ['tooling/*'],
    ...overrides,
  });
const sourcePackage = (path, overrides = {}) => ({
  name: '@davidvornholt/standards',
  version: '0.5.0',
  repository: { directory: path },
  bin: { standards: 'src/cli.ts' },
  exports: {},
  ...overrides,
});
const sourceDirectory = (packages) => {
  const directory = mkdtempSync(join(tmpdir(), 'standards-source-contract-'));
  directories.push(directory);
  for (const [path, packageJson] of packages) {
    const packageFile = join(directory, path, 'package.json');
    mkdirSync(dirname(packageFile), { recursive: true });
    writeFileSync(
      packageFile,
      typeof packageJson === 'string'
        ? packageJson
        : JSON.stringify(packageJson),
    );
  }
  return directory;
};
const hasDependencyProblem = (packageText, rootDirectory) => {
  const inspection = inspectSyncPolicy({
    packageText,
    policyText: undefined,
    rootDirectory,
  });
  return (
    inspection.problems.length === 1 &&
    inspection.problems[0].includes('exact stable version >=0.5.0')
  );
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('sync policy controller contract', () => {
  it('rejects unknown policy keys exactly', () => {
    const inspection = inspectSyncPolicy({
      packageText: consumerPackageText('0.5.0'),
      policyText: JSON.stringify({
        ...DEFAULT_SYNC_POLICY,
        typo: false,
      }),
    });

    assert.ok(
      inspection.problems.includes(
        `${SYNC_POLICY_FILE} has unknown key "typo"`,
      ),
    );
  });

  it('requires a compatible exact package for default policy', () => {
    const inspection = inspectSyncPolicy({
      packageText: consumerPackageText('0.4.0'),
      policyText: undefined,
    });

    assert.equal(inspection.problems.length, 1);
    assert.deepEqual(inspection.policy, DEFAULT_SYNC_POLICY);
    assert.ok(inspection.problems[0].includes('exact stable version >=0.5.0'));
  });
});

describe('standards source identity', () => {
  it('does not waive consumer checks from its own package metadata', () => {
    const directory = sourceDirectory([]);
    assert.equal(
      hasDependencyProblem(
        JSON.stringify({
          ...sourcePackage('.'),
          private: true,
          workspaces: [],
        }),
        directory,
      ),
      true,
    );
  });

  it('derives a moved source package path from workspace ownership', () => {
    const path = 'tooling/standards-runtime';
    const directory = sourceDirectory([[path, sourcePackage(path)]]);
    const inspection = inspectSyncPolicy({
      packageText: sourceRootText({
        scripts: { standards: 'rewritten' },
        workspaces: [path],
      }),
      policyText: undefined,
      rootDirectory: directory,
    });

    assert.deepEqual(inspection.problems, []);
  });

  it('requires every semantic source identity relationship', () => {
    const fixtures = [
      [sourceRootText({ name: 'standards-lookalike' }), {}],
      [sourceRootText({ private: false }), {}],
      [sourceRootText(), { name: 'standards-lookalike' }],
      [sourceRootText(), { version: '^0.5.0' }],
      [sourceRootText(), { repository: {} }],
      [sourceRootText(), { repository: { directory: 'tooling/old-path' } }],
      [sourceRootText(), { bin: {} }],
      [sourceRootText(), { exports: { '.': './src/cli.ts' } }],
    ];

    const failures = fixtures.map(([packageText, sourceOverrides]) => {
      const path = 'tooling/standards-runtime';
      const directory = sourceDirectory([
        [path, sourcePackage(path, sourceOverrides)],
      ]);
      return hasDependencyProblem(packageText, directory);
    });
    assert.deepEqual(
      failures,
      Array.from({ length: fixtures.length }, () => true),
    );
  });

  it('fails closed on duplicate or lookalike workspace packages', () => {
    const first = 'tooling/standards-a';
    const second = 'tooling/standards-b';
    const duplicateDirectory = sourceDirectory([
      [first, sourcePackage(first)],
      [second, sourcePackage(second, { bin: {} })],
    ]);
    assert.equal(
      hasDependencyProblem(sourceRootText(), duplicateDirectory),
      true,
    );

    const lookalikeDirectory = sourceDirectory([
      [first, sourcePackage(first, { name: 'standards-lookalike' })],
    ]);
    assert.equal(
      hasDependencyProblem(sourceRootText(), lookalikeDirectory),
      true,
    );
  });

  it('fails closed on malformed or ambiguous workspace declarations', () => {
    const path = 'tooling/standards-runtime';
    const validDirectory = sourceDirectory([[path, sourcePackage(path)]]);
    const malformedDeclarations = [
      { packages: ['tooling/*'] },
      ['tooling/**'],
      ['../tooling/*'],
      ['tooling/*', path],
      ['tooling/*', 1],
    ];
    assert.deepEqual(
      malformedDeclarations.map((workspaces) =>
        hasDependencyProblem(sourceRootText({ workspaces }), validDirectory),
      ),
      Array.from({ length: malformedDeclarations.length }, () => true),
    );

    const malformedDirectory = sourceDirectory([[path, '{']]);
    assert.equal(
      hasDependencyProblem(sourceRootText(), malformedDirectory),
      true,
    );
  });
});

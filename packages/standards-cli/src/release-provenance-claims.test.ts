import { describe, expect, it } from 'bun:test';
import { Buffer } from 'node:buffer';
import {
  type JsonRecord,
  type ProvenanceExpectation,
  verifiedStatementProblems,
  workflowPathFromRef,
} from './release-provenance-claims';

const SHA = '1234567890abcdef1234567890abcdef12345678';
const MISMATCHED_SHA = 'ffffffffffffffffffffffffffffffffffffffff';
const REPOSITORY = 'https://github.com/davidvornholt/standards';
const WORKFLOW = '.github/workflows/publish-standards-cli.yml';
const SHA512_BYTE_LENGTH = 64;
const SHA512_HEX_LENGTH = 128;
const SUBJECT_DIGEST = 'a1'.repeat(SHA512_BYTE_LENGTH);
const INSTALLED_INTEGRITY = `sha512-${Buffer.from(SUBJECT_DIGEST, 'hex').toString('base64')}`;

const expectation: ProvenanceExpectation = {
  packageName: '@davidvornholt/standards',
  version: '0.14.0',
  repository: REPOSITORY,
  workflowPath: WORKFLOW,
  commit: SHA,
  installedIntegrity: INSTALLED_INTEGRITY,
};

const statement = (): JsonRecord => ({
  _type: 'https://in-toto.io/Statement/v1',
  subject: [
    {
      name: 'pkg:npm/%40davidvornholt/standards@0.14.0',
      digest: { sha512: SUBJECT_DIGEST },
    },
  ],
  predicateType: 'https://slsa.dev/provenance/v1',
  predicate: {
    buildDefinition: {
      buildType:
        'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
      externalParameters: {
        workflow: {
          repository: REPOSITORY,
          path: WORKFLOW,
        },
      },
      resolvedDependencies: [
        {
          uri: `git+${REPOSITORY}@refs/heads/main`,
          digest: { gitCommit: SHA },
        },
      ],
    },
  },
});

const changedStatement = (
  change: (value: Record<string, unknown>) => void,
): JsonRecord => {
  const value = structuredClone(statement()) as Record<string, unknown>;
  change(value);
  return value;
};

const nestedRecord = (
  value: Record<string, unknown>,
  ...path: ReadonlyArray<string>
): Record<string, unknown> => {
  let current = value;
  for (const key of path) {
    current = current[key] as Record<string, unknown>;
  }
  return current;
};

describe('verified npm provenance claims', () => {
  it('accepts the exact repository, workflow, commit, subject, and installed digest', () => {
    expect(verifiedStatementProblems(statement(), expectation)).toEqual([]);
  });

  it.each([
    [
      'repository',
      (value: Record<string, unknown>) => {
        nestedRecord(
          value,
          'predicate',
          'buildDefinition',
          'externalParameters',
          'workflow',
        ).repository = 'https://github.com/example/standards';
      },
      'repository must be',
    ],
    [
      'workflow',
      (value: Record<string, unknown>) => {
        nestedRecord(
          value,
          'predicate',
          'buildDefinition',
          'externalParameters',
          'workflow',
        ).path = '.github/workflows/other.yml';
      },
      'workflow must be',
    ],
    [
      'resolved commit',
      (value: Record<string, unknown>) => {
        const dependencies = nestedRecord(value, 'predicate', 'buildDefinition')
          .resolvedDependencies as Array<Record<string, unknown>>;
        nestedRecord(dependencies[0] ?? {}, 'digest').gitCommit =
          MISMATCHED_SHA;
      },
      'resolved commit must be',
    ],
    [
      'package subject',
      (value: Record<string, unknown>) => {
        const subjects = value.subject as Array<Record<string, unknown>>;
        (subjects[0] ?? {}).name = 'pkg:npm/example@0.14.0';
      },
      'provenance subject must be',
    ],
    [
      'subject digest',
      (value: Record<string, unknown>) => {
        const subjects = value.subject as Array<Record<string, unknown>>;
        nestedRecord(subjects[0] ?? {}, 'digest').sha512 = 'f'.repeat(
          SHA512_HEX_LENGTH,
        );
      },
      'digest must match installed package',
    ],
  ] as const)('rejects a mismatched %s', (_label, change, problem) => {
    expect(
      verifiedStatementProblems(changedStatement(change), expectation).join(
        '\n',
      ),
    ).toContain(problem);
  });

  it('rejects an installed integrity mismatch', () => {
    expect(
      verifiedStatementProblems(statement(), {
        ...expectation,
        installedIntegrity: `sha512-${Buffer.alloc(SHA512_BYTE_LENGTH).toString('base64')}`,
      }).join('\n'),
    ).toContain('digest must match installed package');
  });

  it('derives the workflow path from the exact repository workflow context', () => {
    expect(
      workflowPathFromRef(
        'davidvornholt/standards',
        'davidvornholt/standards/.github/workflows/publish-standards-cli.yml@refs/heads/main',
      ),
    ).toBe(WORKFLOW);
    expect(
      workflowPathFromRef(
        'davidvornholt/standards',
        'example/standards/.github/workflows/publish-standards-cli.yml@refs/heads/main',
      ),
    ).toBeNull();
  });
});

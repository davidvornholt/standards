import { describe, expect, it } from 'bun:test';
import {
  type GithubReleaseState,
  githubReconciliationPlan,
  provenanceProblems,
  workflowPathFromRef,
} from './release-recovery';

const SHA = '1234567890abcdef1234567890abcdef12345678';
const MISMATCHED_SHA = 'ffffffffffffffffffffffffffffffffffffffff';
const REPOSITORY = 'https://github.com/davidvornholt/standards';
const WORKFLOW = '.github/workflows/publish-standards-cli.yml';

const expectation = {
  packageName: '@davidvornholt/standards',
  version: '0.14.0',
  repository: REPOSITORY,
  workflowPath: WORKFLOW,
  commit: SHA,
} as const;

const provenance = (
  overrides: {
    readonly commit?: string;
    readonly repository?: string;
    readonly workflow?: string;
  } = {},
): unknown => {
  const repository = overrides.repository ?? REPOSITORY;
  const statement = {
    subject: [{ name: 'pkg:npm/%40davidvornholt/standards@0.14.0' }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository,
            path: overrides.workflow ?? WORKFLOW,
          },
        },
        resolvedDependencies: [
          {
            uri: `git+${repository}@refs/heads/main`,
            digest: { gitCommit: overrides.commit ?? SHA },
          },
        ],
      },
    },
  };
  return {
    attestations: [
      {
        predicateType: 'https://slsa.dev/provenance/v1',
        bundle: {
          dsseEnvelope: {
            payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
          },
        },
      },
    ],
  };
};

describe('existing npm version provenance', () => {
  it('accepts matching signed provenance claims after npm verifies the bundle', () => {
    expect(provenanceProblems(provenance(), expectation)).toEqual([]);
  });

  it.each([
    ['missing provenance', { attestations: [] }, 'exactly one SLSA'],
    [
      'invalid provenance',
      {
        attestations: [
          {
            predicateType: 'https://slsa.dev/provenance/v1',
            bundle: { dsseEnvelope: { payload: 'not base64' } },
          },
        ],
      },
      'valid base64-encoded JSON',
    ],
  ])('rejects %s', (_label, response, expectedProblem) => {
    expect(provenanceProblems(response, expectation).join('\n')).toContain(
      expectedProblem,
    );
  });

  it.each([
    [
      'repository',
      { repository: 'https://github.com/example/standards' },
      'repository must be',
    ],
    [
      'workflow',
      { workflow: '.github/workflows/other.yml' },
      'workflow must be',
    ],
    ['resolved commit', { commit: MISMATCHED_SHA }, 'resolved commit must be'],
  ])('rejects a mismatched %s', (_label, overrides, expectedProblem) => {
    expect(
      provenanceProblems(provenance(overrides), expectation).join('\n'),
    ).toContain(expectedProblem);
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

describe('GitHub release reconciliation', () => {
  it.each([
    ['missing', null, 'create'],
    ['tag-only', SHA, 'create'],
    ['published', SHA, 'none'],
  ] as const)('plans %s state with the expected tag SHA', (state, tagSha, action) => {
    expect(githubReconciliationPlan(state, tagSha, SHA)).toEqual({
      action,
      problem: null,
    });
  });

  it.each([
    'tag-only',
    'published',
  ] as const)('rejects an existing %s SHA mismatch', (state: GithubReleaseState) => {
    const plan = githubReconciliationPlan(state, MISMATCHED_SHA, SHA);
    expect(plan.action).toBeNull();
    expect(plan.problem).toContain(`expected ${SHA}`);
  });

  it('rejects an existing draft release', () => {
    expect(githubReconciliationPlan('draft', SHA, SHA).problem).toContain(
      'draft',
    );
  });
});

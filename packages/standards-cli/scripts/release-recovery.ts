#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import process from 'node:process';
import {
  type GithubReleaseState,
  githubReconciliationPlan,
  npmReleasePlan,
  type ProvenanceVerificationResult,
} from '../src/release-recovery.ts';

const reportProblems = (problems: ReadonlyArray<string>) => {
  for (const problem of problems) {
    process.stderr.write(`::error::${problem}\n`);
  }
  return problems.length === 0 ? 0 : 1;
};

type ProvenanceArguments = readonly [
  path: string,
  packageName: string,
  version: string,
  repository: string,
  serverUrl: string,
  workflowRef: string,
  commit: string,
  installedIntegrity: string,
  tufCachePath: string,
];
const PROVENANCE_ARGUMENT_COUNT: ProvenanceArguments['length'] = 9;

const hasProvenanceArguments = (
  values: ReadonlyArray<string>,
): values is ProvenanceArguments =>
  values.length === PROVENANCE_ARGUMENT_COUNT &&
  values.every((argument) => argument.length > 0);

const runProvenanceVerification = (
  values: ReadonlyArray<string>,
): Promise<number> => {
  if (!hasProvenanceArguments(values)) {
    return Promise.resolve(
      reportProblems([
        'Provenance verification requires a response path, installed integrity, TUF cache, and complete GitHub release context',
      ]),
    );
  }
  const [
    path,
    packageName,
    version,
    repository,
    serverUrl,
    workflowRef,
    commit,
    installedIntegrity,
    tufCachePath,
  ] = values;
  let response: unknown;
  try {
    response = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    const result: ProvenanceVerificationResult = {
      kind: 'malformed-provenance',
      message: 'npm attestation response must contain valid JSON',
    };
    return Promise.resolve(reportProvenanceResult(result));
  }
  return Promise.all([
    import('../src/release-provenance.ts'),
    import('../src/release-provenance-claims.ts'),
  ])
    .then(([{ verifyProvenance }, { workflowPathFromRef }]) => {
      const workflowPath = workflowPathFromRef(repository, workflowRef);
      if (workflowPath === null) {
        return {
          kind: 'malformed-provenance',
          message: `Invalid GitHub workflow ref: ${workflowRef}`,
        } as const;
      }
      return verifyProvenance(
        response,
        {
          packageName,
          version,
          repository: `${serverUrl}/${repository}`,
          workflowPath,
          commit,
          installedIntegrity,
        },
        `${serverUrl}/${workflowRef}`,
        tufCachePath,
      );
    })
    .then(reportProvenanceResult);
};

const reportProvenanceResult = (result: ProvenanceVerificationResult) => {
  switch (result.kind) {
    case 'verified':
      return 0;
    case 'malformed-provenance':
    case 'cryptographic-verification-failure':
    case 'operational-verification-failure':
      process.stderr.write(`::error::[${result.kind}] ${result.message}\n`);
      return 1;
    default: {
      const unhandled: never = result;
      return unhandled;
    }
  }
};

const planGithubReconciliation = (
  rawState: string | undefined,
  rawTagSha: string | undefined,
  releaseSha: string | undefined,
) => {
  const states: ReadonlyArray<GithubReleaseState> = [
    'draft',
    'missing',
    'published',
    'tag-only',
  ];
  const state = states.find((candidate) => candidate === rawState);
  if (releaseSha === undefined || state === undefined) {
    return reportProblems([
      'GitHub reconciliation requires a valid release state',
    ]);
  }
  const plan = githubReconciliationPlan(
    state,
    rawTagSha === '' || rawTagSha === undefined ? null : rawTagSha,
    releaseSha,
  );
  if (plan.problem !== null) {
    return reportProblems([plan.problem]);
  }
  process.stdout.write(`${plan.action}\n`);
  return 0;
};

const planNpmRelease = (
  version: string | undefined,
  latest: string | undefined,
  rawExactVersionExists: string | undefined,
) => {
  if (
    version === undefined ||
    latest === undefined ||
    (rawExactVersionExists !== 'true' && rawExactVersionExists !== 'false')
  ) {
    return reportProblems([
      'npm-state requires manifest version, latest version, and exact-version existence',
    ]);
  }
  const plan = npmReleasePlan(
    version,
    latest,
    rawExactVersionExists === 'true',
  );
  if (plan.problem !== null) {
    return reportProblems([plan.problem]);
  }
  process.stdout.write(`${plan.action}\n`);
  return 0;
};

const [, , command, ...args] = process.argv;
const run = (): Promise<number> => {
  if (command === 'provenance') {
    return runProvenanceVerification(args);
  }
  if (command === 'github-state') {
    return Promise.resolve(planGithubReconciliation(args[0], args[1], args[2]));
  }
  if (command === 'npm-state') {
    return Promise.resolve(planNpmRelease(args[0], args[1], args[2]));
  }
  return Promise.resolve(
    reportProblems([
      'Expected provenance, npm-state, or github-state release recovery command',
    ]),
  );
};

run().then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    process.exitCode = reportProblems([
      `Release recovery failed: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  },
);

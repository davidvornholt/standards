#!/usr/bin/env node

import process from 'node:process';
import {
  type GithubReleaseState,
  githubReconciliationPlan,
  npmReleasePlan,
  type ProvenanceVerificationResult,
  releaseDeclarationPlan,
} from '../src/release-recovery.ts';

const reportProblems = (problems: ReadonlyArray<string>) => {
  for (const problem of problems) {
    process.stderr.write(`::error::${problem}\n`);
  }
  return problems.length === 0 ? 0 : 1;
};

const runProvenanceVerification = (
  values: ReadonlyArray<string>,
): Promise<number> =>
  import('../src/release-provenance-cli.ts')
    .then(({ verifyProvenanceArguments }) => verifyProvenanceArguments(values))
    .then(reportProvenanceResult);

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

const planReleaseDeclaration = (
  version: string | undefined,
  previousVersion: string | undefined,
) => {
  if (version === undefined || previousVersion === undefined) {
    return reportProblems([
      'declaration requires the manifest version and the previously declared version',
    ]);
  }
  const plan = releaseDeclarationPlan(version, previousVersion);
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
  if (command === 'declaration') {
    return Promise.resolve(planReleaseDeclaration(args[0], args[1]));
  }
  return Promise.resolve(
    reportProblems([
      'Expected declaration, provenance, npm-state, or github-state release recovery command',
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

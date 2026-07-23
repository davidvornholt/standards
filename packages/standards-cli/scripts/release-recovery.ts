#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import process from 'node:process';
import {
  type GithubReleaseState,
  githubReconciliationPlan,
  provenanceProblems,
  workflowPathFromRef,
} from '../src/release-recovery';

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
];
const PROVENANCE_ARGUMENT_COUNT: ProvenanceArguments['length'] = 7;

const hasProvenanceArguments = (
  values: ReadonlyArray<string>,
): values is ProvenanceArguments =>
  values.length === PROVENANCE_ARGUMENT_COUNT &&
  values.every((argument) => argument.length > 0);

const verifyProvenance = (values: ReadonlyArray<string>) => {
  if (!hasProvenanceArguments(values)) {
    return reportProblems([
      'Provenance verification requires a response path and complete GitHub release context',
    ]);
  }
  const [
    path,
    packageName,
    version,
    repository,
    serverUrl,
    workflowRef,
    commit,
  ] = values;
  const workflowPath = workflowPathFromRef(repository, workflowRef);
  if (workflowPath === null) {
    return reportProblems([`Invalid GitHub workflow ref: ${workflowRef}`]);
  }
  let response: unknown;
  try {
    response = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return reportProblems(['npm attestation response must contain valid JSON']);
  }
  return reportProblems(
    provenanceProblems(response, {
      packageName,
      version,
      repository: `${serverUrl}/${repository}`,
      workflowPath,
      commit,
    }),
  );
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

const [, , command, ...args] = process.argv;
let exitCode: number;
if (command === 'provenance') {
  exitCode = verifyProvenance(args);
} else if (command === 'github-state') {
  exitCode = planGithubReconciliation(args[0], args[1], args[2]);
} else {
  exitCode = reportProblems([
    'Expected provenance or github-state release recovery command',
  ]);
}
process.exitCode = exitCode;

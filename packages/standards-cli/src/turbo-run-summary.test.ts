// The quality job's Check step writes one Turbo run summary per `turbo run`.
// These tests run the two workflow scripts that read them, the task table and
// the exact prune before a main save, against fixture summaries and caches.

import { afterEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { parse } from 'yaml';
import {
  ACTUAL_UPSTREAM,
  cleanupTmpDirs,
  mkTmp,
  type RunResult,
  runProcess,
  write,
  yamlRunScript,
} from './cli-test-support';

const WORKFLOW = join(ACTUAL_UPSTREAM, '.github/workflows/standards.yml');
const SUMMARY_STEP = 'Summarize Turbo tasks';
const PRUNE_STEP = 'Prune the Turbo cache before save';
const CACHE_DIR = '.turbo/cache';
const EXECUTABLE_MODE = 0o755;
const ARTIFACT_SIZE = 4096;
const BUDGET_ASSIGNMENT = 'budget=$((2 * 1024 * 1024))';
// Room for two 4 KiB artifacts.
const TWO_ARTIFACT_BUDGET = 'budget=8';
const OLDEST_MTIME = 100;
const MIDDLE_MTIME = 200;
const NEWEST_MTIME = 300;
const BUILD_START_MS = 1000;
const BUILD_END_MS = 3500;
const HIT_END_MS = 40;
const INTEGRATION_END_MS = 12_000;

type QualityStep = { readonly name?: string; readonly if?: string };
type TaskStatus = 'HIT' | 'MISS';

afterEach(cleanupTmpDirs);

const qualitySteps = (): ReadonlyArray<QualityStep> =>
  (
    parse(readFileSync(WORKFLOW, 'utf8')) as {
      readonly jobs: {
        readonly quality: { readonly steps: Array<QualityStep> };
      };
    }
  ).jobs.quality.steps;

const task = (
  taskId: string,
  hash: string,
  status: TaskStatus,
  [startTime, endTime]: readonly [number, number],
) => ({
  taskId,
  hash,
  cache: { status },
  execution: { startTime, endTime, exitCode: 0 },
});

const writeSummary = (
  fixture: string,
  name: string,
  tasks: ReadonlyArray<ReturnType<typeof task>>,
): void =>
  write(fixture, `.turbo/runs/${name}.json`, JSON.stringify({ tasks }));

const usedTask = (hash: string) => task(`pkg#${hash}`, hash, 'MISS', [0, 0]);

const writeArtifact = (fixture: string, name: string, mtime?: number): void => {
  write(fixture, `${CACHE_DIR}/${name}`, 'x'.repeat(ARTIFACT_SIZE));
  if (mtime !== undefined) {
    utimesSync(join(fixture, CACHE_DIR, name), mtime, mtime);
  }
};

const cacheContents = (fixture: string): ReadonlyArray<string> =>
  readdirSync(join(fixture, CACHE_DIR)).sort();

const runStep = (
  stepName: string,
  fixture: string,
  env: ReadonlyArray<readonly [string, string]> = [],
  script = yamlRunScript(WORKFLOW, stepName),
): RunResult =>
  runProcess('bash', fixture, ['-c', script], {
    ...process.env,
    ...Object.fromEntries(env),
  });

describe('Turbo task table', () => {
  it('runs after the check, also when it failed', () => {
    const steps = qualitySteps();
    const summaryIndex = steps.findIndex((step) => step.name === SUMMARY_STEP);
    expect(steps[summaryIndex]?.if).toBe('!cancelled()');
    expect(summaryIndex).toBeGreaterThan(
      steps.findIndex((step) => step.name === 'Check'),
    );
  });

  it('lists every task of every run summary by duration', () => {
    const fixture = mkTmp('turbo-task-table-');
    writeSummary(fixture, 'first', [
      task('a#build', 'aaaa', 'MISS', [BUILD_START_MS, BUILD_END_MS]),
      task('b#test', 'bbbb', 'HIT', [0, HIT_END_MS]),
    ]);
    writeSummary(fixture, 'second', [
      task('c#test:integration', 'cccc', 'MISS', [0, INTEGRATION_END_MS]),
    ]);
    const stepSummary = join(fixture, 'step-summary.md');

    const result = runStep(SUMMARY_STEP, fixture, [
      ['GITHUB_STEP_SUMMARY', stepSummary],
    ]);

    const table = [
      '### Turbo tasks',
      '',
      '1 of 3 tasks restored from the Turbo cache.',
      '',
      '| Task | Cache | Seconds |',
      '| --- | --- | ---: |',
      '| `c#test:integration` | MISS | 12 |',
      '| `a#build` | MISS | 2.5 |',
      '| `b#test` | HIT | 0 |',
      '',
    ].join('\n');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(table);
    expect(readFileSync(stepSummary, 'utf8')).toBe(table);
  });

  it('writes nothing when Turbo never ran', () => {
    const fixture = mkTmp('turbo-task-table-absent-');
    const stepSummary = join(fixture, 'step-summary.md');

    const result = runStep(SUMMARY_STEP, fixture, [
      ['GITHUB_STEP_SUMMARY', stepSummary],
    ]);

    expect(result.status).toBe(0);
    expect(existsSync(stepSummary)).toBe(false);
  });

  it('fails on an unreadable run summary', () => {
    const fixture = mkTmp('turbo-task-table-malformed-');
    write(fixture, '.turbo/runs/broken.json', '{"tasks": [');

    const result = runStep(SUMMARY_STEP, fixture, [
      ['GITHUB_STEP_SUMMARY', join(fixture, 'step-summary.md')],
    ]);

    expect(result.status).not.toBe(0);
  });
});

describe('exact Turbo prune', () => {
  it('keeps only the artifacts whose hashes a run summary lists', () => {
    const fixture = mkTmp('turbo-prune-exact-');
    writeSummary(fixture, 'first', [
      usedTask('aaaa1111'),
      usedTask('bbbb2222'),
    ]);
    writeSummary(fixture, 'second', [usedTask('cccc3333')]);
    for (const name of [
      'aaaa1111.tar.zst',
      'aaaa1111-meta.json',
      'aaaa1111-manifest.json',
      'bbbb2222.tar.zst',
      'cccc3333-meta.json',
      // An older tree's task: no summary lists it.
      'dddd4444.tar.zst',
      'dddd4444-meta.json',
      // A listed hash must match the whole artifact name prefix.
      'aaaa11110.tar.zst',
    ]) {
      writeArtifact(fixture, name);
    }

    expect(runStep(PRUNE_STEP, fixture).status).toBe(0);
    expect(cacheContents(fixture)).toEqual([
      'aaaa1111-manifest.json',
      'aaaa1111-meta.json',
      'aaaa1111.tar.zst',
      'bbbb2222.tar.zst',
      'cccc3333-meta.json',
    ]);
  });

  // Without run summaries, as when Turbo never ran, only the cap applies.
  it.each([true, false])(
    'caps the cache at the byte budget, newest first, with a run summary: %p',
    (withSummary) => {
      const fixture = mkTmp('turbo-prune-budget-');
      if (withSummary) {
        writeSummary(fixture, 'run', [
          usedTask('oldest'),
          usedTask('middle'),
          usedTask('newest'),
        ]);
        writeArtifact(fixture, 'unused.tar.zst', NEWEST_MTIME);
      }
      writeArtifact(fixture, 'oldest.tar.zst', OLDEST_MTIME);
      writeArtifact(fixture, 'middle.tar.zst', MIDDLE_MTIME);
      writeArtifact(fixture, 'newest.tar.zst', NEWEST_MTIME);
      const script = yamlRunScript(WORKFLOW, PRUNE_STEP);
      expect(script).toContain(BUDGET_ASSIGNMENT);

      const result = runStep(
        PRUNE_STEP,
        fixture,
        [],
        script.replace(BUDGET_ASSIGNMENT, TWO_ARTIFACT_BUDGET),
      );

      expect(result.status).toBe(0);
      expect(cacheContents(fixture)).toEqual([
        'middle.tar.zst',
        'newest.tar.zst',
      ]);
    },
  );

  it('succeeds without a Turbo cache directory', () => {
    expect(runStep(PRUNE_STEP, mkTmp('turbo-prune-absent-')).status).toBe(0);
  });

  it('fails without pruning on an unreadable run summary', () => {
    const fixture = mkTmp('turbo-prune-exact-malformed-');
    write(fixture, '.turbo/runs/broken.json', '{"tasks": [');
    writeArtifact(fixture, 'aaaa.tar.zst');

    expect(runStep(PRUNE_STEP, fixture).status).not.toBe(0);
    expect(cacheContents(fixture)).toEqual(['aaaa.tar.zst']);
  });

  it.each(['jq', 'find', 'sort', 'awk', 'xargs', 'rm'])(
    'fails when %s fails while pruning',
    (command) => {
      const fixture = mkTmp(`turbo-prune-exact-failing-${command}-`);
      writeSummary(fixture, 'run', [usedTask('kept')]);
      writeArtifact(fixture, 'kept.tar.zst');
      writeArtifact(fixture, 'stale.tar.zst');
      write(fixture, `bin/${command}`, '#!/bin/sh\nexit 42\n');
      chmodSync(join(fixture, `bin/${command}`), EXECUTABLE_MODE);

      const result = runStep(PRUNE_STEP, fixture, [
        ['PATH', `${join(fixture, 'bin')}:${process.env.PATH ?? ''}`],
      ]);

      expect(result.status).not.toBe(0);
    },
  );
});

import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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
const START_STEP = 'Start the runner resource probe';
const SUMMARY_STEP = 'Summarize runner resources';
const SAMPLES = 'runner/runner-resources.tsv';
const HEADER =
  'time_ms\tmemory_used\tmemory_total\tcgroup_memory\tcgroup_limit\tcpu_total\tcpu_idle\tcpu_iowait\tcpu_steal\tcpu_some_us\tmemory_some_us\tmemory_full_us\tio_some_us\tio_full_us\tmajor_faults\toom_kills';
const EPOCH_MS = /^\d{13}$/u;
const POLL_MS = 20;
const POLL_ATTEMPTS = 100;
const STOPPED_WAIT_MS = 200;
const PRESSURE = (some: string, full: string) =>
  `some avg10=1.00 avg60=0.00 avg300=0.00 total=${some}\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=${full}\n`;
// Four GiB of 16 GiB in use at the start, then a 10 s gap in which memory
// nearly ran out and most of the time went to steal and memory stalls.
const STALLED_SAMPLES = [
  '1000000000 4294967296 17179869184 5368709120 16106127360 1000 500 100 0 0 0 0 0 0 100 1',
  '1000002000 6442450944 17179869184 7516192768 16106127360 1800 700 140 8 1000000 200000 100000 400000 0 300 1',
  '1000012000 15032385536 17179869184 15569256448 16106127360 2800 1700 140 408 1000000 9200000 8100000 400000 1000000 5300 2',
];
const STALLED_TABLE = [
  '### Runner resources',
  '',
  '3 samples over 12 s from 13:46:40 UTC. The worst column shows the worst interval between two samples.',
  '',
  '| Measure | Worst | At | Whole check |',
  '| --- | ---: | ---: | ---: |',
  '| Time between samples | 10.0 s | 2 s |  |',
  '| CPU busy | 75.0 % | 0 s | 33.3 % |',
  '| CPU iowait | 5.0 % | 0 s | 2.2 % |',
  '| CPU steal | 40.0 % | 2 s | 22.7 % |',
  '| CPU pressure, some | 50.0 % | 0 s | 8.3 % |',
  '| Memory pressure, some | 90.0 % | 2 s | 76.7 % |',
  '| Memory pressure, full | 80.0 % | 2 s | 67.5 % |',
  '| IO pressure, some | 20.0 % | 0 s | 3.3 % |',
  '| IO pressure, full | 10.0 % | 2 s | 8.3 % |',
  '| Major page faults | 500/s | 2 s | 5200 |',
  '| Memory in use | 14.0 GiB | 12 s | of 16.0 GiB |',
  '| Cgroup memory with page cache | 14.5 GiB | 12 s | of 15.0 GiB |',
  '| OOM kills | | | 1 |',
  '',
].join('\n');

type QualityStep = { readonly name?: string; readonly if?: string };

afterEach(cleanupTmpDirs);

const qualitySteps = (): ReadonlyArray<QualityStep> =>
  (
    parse(readFileSync(WORKFLOW, 'utf8')) as {
      readonly jobs: {
        readonly quality: { readonly steps: Array<QualityStep> };
      };
    }
  ).jobs.quality.steps;

const startScript = (fixture: string): string =>
  yamlRunScript(WORKFLOW, START_STEP)
    .replace('interval=2', 'interval=0.05')
    .replace('proc=/proc', `proc=${fixture}/proc`)
    .replace('cgroup=/sys/fs/cgroup', `cgroup=${fixture}/cgroup`);

const runStep = (
  fixture: string,
  script = yamlRunScript(WORKFLOW, SUMMARY_STEP),
): RunResult => {
  mkdirSync(join(fixture, 'runner'), { recursive: true });
  return runProcess('bash', fixture, ['-c', script], {
    ...process.env,
    ...Object.fromEntries([
      ['RUNNER_TEMP', join(fixture, 'runner')],
      ['GITHUB_STEP_SUMMARY', join(fixture, 'step-summary.md')],
    ]),
  });
};

const sampleRows = (fixture: string): ReadonlyArray<ReadonlyArray<string>> =>
  readFileSync(join(fixture, SAMPLES), 'utf8')
    .trimEnd()
    .split('\n')
    .slice(1)
    .map((line) => line.split('\t'));

const waitForSamples = async (
  fixture: string,
  count: number,
  attempts = POLL_ATTEMPTS,
): Promise<void> => {
  if (sampleRows(fixture).length >= count) {
    return;
  }
  if (attempts === 0) {
    throw new Error(`The probe took fewer than ${count} samples`);
  }
  await globalThis.Bun.sleep(POLL_MS);
  await waitForSamples(fixture, count, attempts - 1);
};

const writeProc = (fixture: string, withPressure: boolean): void => {
  write(fixture, 'proc/stat', 'cpu  100 20 30 400 50 6 7 8 9 10\n');
  write(
    fixture,
    'proc/meminfo',
    'MemTotal:       16000 kB\nMemFree:         1000 kB\nMemAvailable:    6000 kB\n',
  );
  write(fixture, 'proc/vmstat', 'pgfault 999\npgmajfault 42\noom_kill 3\n');
  if (withPressure) {
    write(fixture, 'proc/pressure/cpu', PRESSURE('111', '0'));
    write(fixture, 'proc/pressure/memory', PRESSURE('222', '333'));
    write(fixture, 'proc/pressure/io', PRESSURE('444', '555'));
  }
};

const writeSamples = (fixture: string, rows: ReadonlyArray<string>): void =>
  write(fixture, SAMPLES, `${[HEADER, ...rows].join('\n')}\n`);

describe('runner resource probe', () => {
  it('samples throughout the check and summarizes after it, also when it failed', () => {
    const names = qualitySteps().map((step) => step.name);
    const summary = qualitySteps().find((step) => step.name === SUMMARY_STEP);

    expect(names.indexOf(START_STEP)).toBe(names.indexOf('Check') - 1);
    expect(names.indexOf(SUMMARY_STEP)).toBe(
      names.indexOf('Summarize Turbo tasks') + 1,
    );
    expect(summary?.if).toBe('!cancelled()');
  });

  it('records each source until the summary stops it', async () => {
    const fixture = mkTmp('runner-resources-sample-');
    writeProc(fixture, true);
    write(fixture, 'cgroup/memory.current', '5000\n');
    write(fixture, 'cgroup/memory.max', '15000\n');

    // A sampler that held the step's output open would block this call.
    expect(runStep(fixture, startScript(fixture)).status).toBe(0);
    await waitForSamples(fixture, 2);
    expect(runStep(fixture).status).toBe(0);
    const stopped = sampleRows(fixture).length;
    await globalThis.Bun.sleep(STOPPED_WAIT_MS);

    expect(sampleRows(fixture)).toHaveLength(stopped);
    for (const [time, ...values] of sampleRows(fixture)) {
      expect(time).toMatch(EPOCH_MS);
      expect(values.join(',')).toBe(
        '10240000,16384000,5000,15000,621,450,50,8,111,222,333,444,555,42,3',
      );
    }
  });

  it.each([
    ['', '10240000,16384000,,,621,450,50,8,,,,,,42,3'],
    ['stat', '10240000,16384000,,,,,,,,,,,,42,3'],
    ['meminfo', ',,,,621,450,50,8,,,,,,42,3'],
    ['vmstat', '10240000,16384000,,,621,450,50,8,,,,,,,'],
  ])(
    'leaves the columns of missing sources empty: %s',
    async (missing, values) => {
      const fixture = mkTmp('runner-resources-missing-');
      writeProc(fixture, false);
      write(fixture, 'cgroup/memory.max', 'max\n');
      if (missing) {
        rmSync(join(fixture, 'proc', missing));
      }

      expect(runStep(fixture, startScript(fixture)).status).toBe(0);
      let result: RunResult;
      try {
        await waitForSamples(fixture, 2);
      } finally {
        result = runStep(fixture);
      }

      expect(result.status).toBe(0);
      expect(sampleRows(fixture)[0]?.slice(1).join(',')).toBe(values);
      expect(result.stdout).toContain(
        missing === 'meminfo'
          ? '| Memory in use | n/a | |  |'
          : '| Memory in use | 0.0 GiB | 0 s | of 0.0 GiB |',
      );
      expect(result.stdout).toContain(
        missing === 'vmstat'
          ? '| Major page faults | n/a | | n/a |'
          : '| Major page faults | 0/s | 0 s | 0 |',
      );
      expect(result.stdout).toContain(
        '| Memory pressure, full | n/a | | n/a |',
      );
      expect(result.stdout).toContain(
        '| Cgroup memory with page cache | n/a | | n/a |',
      );
    },
  );
});

describe('runner resource summary', () => {
  it('reports the worst interval and the whole check', () => {
    const fixture = mkTmp('runner-resources-summary-');
    writeSamples(
      fixture,
      STALLED_SAMPLES.map((row) => row.replaceAll(' ', '\t')),
    );

    const result = runStep(fixture);

    expect(result.status).toBe(0);
    expect(result.stdout).toEndWith(STALLED_TABLE);
    expect(readFileSync(join(fixture, 'step-summary.md'), 'utf8')).toBe(
      STALLED_TABLE,
    );
  });

  it('notes a probe that took fewer than two samples', () => {
    const fixture = mkTmp('runner-resources-short-');
    writeSamples(fixture, ['1000000000\t1\t2\t\t\t3\t1\t0\t0']);

    const result = runStep(fixture);

    expect(result.status).toBe(0);
    expect(result.stdout).toEndWith(
      '### Runner resources\n\nThe probe took fewer than two samples.\n',
    );
  });

  it('writes nothing when the probe never started', () => {
    const fixture = mkTmp('runner-resources-absent-');

    const result = runStep(fixture);

    expect(result.status).toBe(0);
    expect(existsSync(join(fixture, 'step-summary.md'))).toBe(false);
  });
});

import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const ROOT = join(import.meta.dir, '../../..');
const PREFLIGHT = join(ROOT, '.github/scripts/standards-sync-preflight.mjs');
const WORKFLOW = join(ROOT, '.github/workflows/standards-sync.yml');
const MANIFEST = join(ROOT, 'sync-standards.json');
const POLICY_FILE = 'sync-standards.local.json';
const GATED_STEPS = [
  'Setup Bun',
  'Install dependencies',
  'Sync canonical files from upstream',
  'Open a pull request if the mirror changed',
] as const;
const DOCS = [
  join(ROOT, 'README.md'),
  join(ROOT, 'template/README.md'),
  join(ROOT, 'packages/standards-cli/README.md'),
  join(ROOT, '.agents/skills/standards-sync/SKILL.md'),
] as const;

type RunResult = {
  readonly output: string;
  readonly status: number;
  readonly stderr: string;
  readonly stdout: string;
};

const temporaryDirectories: Array<string> = [];

const runPreflight = (
  eventName: 'schedule' | 'workflow_dispatch',
  policy: string | undefined,
): RunResult => {
  const directory = mkdtempSync(join(tmpdir(), 'standards-preflight-'));
  temporaryDirectories.push(directory);
  const outputPath = join(directory, 'github-output');
  if (policy !== undefined) {
    writeFileSync(join(directory, POLICY_FILE), policy);
  }
  const environment = { ...process.env };
  const eventNameVariable = 'GITHUB_EVENT_NAME';
  const outputVariable = 'GITHUB_OUTPUT';
  environment[eventNameVariable] = eventName;
  environment[outputVariable] = outputPath;

  const result = spawnSync('node', [PREFLIGHT], {
    cwd: directory,
    encoding: 'utf8',
    env: environment,
  });
  return {
    output: existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '',
    status: result.status ?? 1,
    stderr: result.stderr,
    stdout: result.stdout,
  };
};

const workflowStep = (workflow: string, name: string): string => {
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  if (start === -1) {
    throw new Error(`Workflow step not found: ${name}`);
  }
  const next = workflow.indexOf('\n      - name:', start + marker.length);
  return workflow.slice(start, next === -1 ? undefined : next);
};

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe('scheduled sync preflight', () => {
  it('disables a scheduled run before dependency setup when policy opts out', () => {
    const result = runPreflight(
      'schedule',
      JSON.stringify({ ref: 'refs/heads/main', scheduledSync: false }),
    );

    expect(result.status).toBe(0);
    expect(result.output).toBe('run_sync=false\n');
    expect(result.stdout).toContain('scheduled sync disabled');
  });

  it('enables scheduled runs when policy opts in or is missing', () => {
    const configured = runPreflight(
      'schedule',
      JSON.stringify({ ref: 'refs/heads/main', scheduledSync: true }),
    );
    const missing = runPreflight('schedule', undefined);

    expect(configured.output).toBe('run_sync=true\n');
    expect(missing.output).toBe('run_sync=true\n');
  });

  it('keeps manual dispatch enabled when scheduled runs are disabled', () => {
    const result = runPreflight(
      'workflow_dispatch',
      JSON.stringify({ ref: 'refs/heads/main', scheduledSync: false }),
    );

    expect(result.status).toBe(0);
    expect(result.output).toBe('run_sync=true\n');
  });

  it('fails closed on malformed policy or a missing scheduledSync field', () => {
    for (const policy of ['not json', '{}', '{"scheduledSync":"false"}']) {
      const result = runPreflight('schedule', policy);
      expect(result.status).not.toBe(0);
      expect(result.output).toBe('');
      expect(result.stderr.length).toBeGreaterThan(0);
    }
  });
});

describe('canonical scheduled sync contract', () => {
  it('runs the preflight after checkout and gates every paid step', () => {
    const workflow = readFileSync(WORKFLOW, 'utf8');
    const checkout = workflow.indexOf('      - name: Checkout');
    const preflight = workflow.indexOf(
      '      - name: Check scheduled sync policy',
    );
    const setup = workflow.indexOf('      - name: Setup Bun');

    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(preflight).toBeGreaterThan(checkout);
    expect(setup).toBeGreaterThan(preflight);
    expect(workflowStep(workflow, 'Check scheduled sync policy')).toContain(
      'run: node .github/scripts/standards-sync-preflight.mjs',
    );
    for (const name of GATED_STEPS) {
      expect(workflowStep(workflow, name)).toContain(
        "if: steps.preflight.outputs.run_sync == 'true'",
      );
    }
  });

  it('syncs the preflight as canonical content', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
      readonly paths: ReadonlyArray<string>;
    };

    expect(manifest.paths).toContain(
      '.github/scripts/standards-sync-preflight.mjs',
    );
  });

  it('documents the old-consumer upgrade before non-default policy', () => {
    for (const path of DOCS) {
      const documentation = readFileSync(path, 'utf8');
      expect(documentation).toContain('@davidvornholt/standards` >=0.5.0');
      expect(documentation).toContain(
        'bun add --dev --exact @davidvornholt/standards@0.5.0',
      );
    }
  });
});

import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const ROOT = join(import.meta.dir, '../../..');
const PREFLIGHT = join(
  ROOT,
  '.github/actions/standards-sync-preflight/index.mjs',
);
const LOCK = join(ROOT, 'sync-standards.lock');
const EVENT_NAME_VARIABLE = 'GITHUB_EVENT_NAME';
const OUTPUT_VARIABLE = 'GITHUB_OUTPUT';
const WORKSPACE_VARIABLE = 'GITHUB_WORKSPACE';
const ROOT_PACKAGE = join(ROOT, 'package.json');
const TEMPLATE_PACKAGE = join(ROOT, 'template/package.json');
const TURBO_CONFIG = join(ROOT, 'turbo.json');
const readLock = (): string | undefined =>
  existsSync(LOCK) ? readFileSync(LOCK, 'utf8') : undefined;

describe('standards source workspace', () => {
  it('keeps the complete quality gate behind the cheap live-settings precondition', () => {
    const packageJson = JSON.parse(readFileSync(ROOT_PACKAGE, 'utf8')) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    const templatePackage = JSON.parse(
      readFileSync(TEMPLATE_PACKAGE, 'utf8'),
    ) as { readonly scripts: Readonly<Record<string, string>> };
    const turbo = JSON.parse(readFileSync(TURBO_CONFIG, 'utf8')) as {
      readonly tasks: Readonly<Record<string, unknown>>;
    };
    const precondition =
      'turbo run standards --filter @davidvornholt/standards -- github --check';

    expect(packageJson.scripts.check).toBe(
      `${precondition} && turbo run lint check-types test build test:a11y`,
    );
    expect(packageJson.scripts['check:fix']).toBe(
      `${precondition} && turbo run lint:fix check-types test build test:a11y`,
    );
    expect(packageJson.scripts['test:a11y']).toBe('turbo run test:a11y');
    expect(templatePackage.scripts).toMatchObject({
      check:
        'standards check && turbo run lint check-types test build test:a11y',
      'check:fix':
        'standards check && turbo run lint:fix check-types test build test:a11y',
      'test:a11y': 'turbo run test:a11y',
    });
    expect(turbo.tasks).toHaveProperty('build');
    expect(turbo.tasks).toHaveProperty('test:a11y');
  });

  it('passes real-root scheduled and repository-dispatch preflight', () => {
    for (const eventName of ['schedule', 'repository_dispatch']) {
      const directory = mkdtempSync(join(tmpdir(), 'standards-source-'));
      const output = join(directory, 'github-output');
      try {
        const environment = { ...process.env };
        environment[EVENT_NAME_VARIABLE] = eventName;
        environment[OUTPUT_VARIABLE] = output;
        environment[WORKSPACE_VARIABLE] = ROOT;
        const result = spawnSync('node', [PREFLIGHT], {
          cwd: ROOT,
          encoding: 'utf8',
          env: environment,
        });

        expect(result.status).toBe(0);
        expect(readFileSync(output, 'utf8')).toBe('run_sync=true\n');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it('keeps a real-root local dry run as a no-op', () => {
    const lockBefore = readLock();
    const result = spawnSync(
      'bun',
      ['standards', 'sync', '--from', '.', '--dry-run'],
      {
        cwd: ROOT,
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('dry run: already in sync; no changes');
    expect(readLock()).toBe(lockBefore);
  });
});

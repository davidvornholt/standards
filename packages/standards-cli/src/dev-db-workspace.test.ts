import { afterEach, describe, expect, it } from 'bun:test';
import { rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import {
  ACTUAL_UPSTREAM,
  cleanupTmpDirs,
  mkTmp,
  runProcess,
  write,
} from './cli-test-support';
import {
  calls,
  createFixture,
  expectedRunArguments,
  present,
  run,
} from './dev-db-test-support';

const databaseUrl = 'postgres://file-user:file-pass@localhost:5440/file-db';
const cli = join(ACTUAL_UPSTREAM, 'packages/standards-cli/src/cli.ts');
const fixture = () => createFixture('acme', databaseUrl, process.env);
type Fixture = ReturnType<typeof fixture>;

const selectWorkspace = (value: Fixture, workspace: unknown): void => {
  write(
    value.root,
    'package.json',
    JSON.stringify({
      name: 'acme',
      devDatabase: { postgresVersion: '17', workspace },
      scripts: { standards: `bun ${JSON.stringify(cli)}` },
    }),
  );
};
const writeWorkspace = (root: string, workspace: string): void => {
  write(root, `${workspace}/package.json`, '{"name":"@acme/database"}');
  write(
    root,
    `${workspace}/.env.local`,
    `DATABASE_URL=${JSON.stringify(databaseUrl)}\n`,
  );
};

afterEach(cleanupTmpDirs);

describe('dev database workspace selection', () => {
  it('starts an app-private database without packages/db through the canonical recipe', () => {
    const value = fixture();
    selectWorkspace(value, 'apps/web');
    writeWorkspace(value.root, 'apps/web');
    rmSync(join(value.root, 'packages'), { recursive: true });
    const result = runProcess(
      'just',
      value.root,
      ['dev-db-start'],
      value.environment,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'accepts the configured DATABASE_URL on 127.0.0.1:5440',
    );
    expect(calls(value)).toContain(
      JSON.stringify(expectedRunArguments(value.name)),
    );
    for (const action of ['status', 'stop']) {
      expect(
        runProcess('just', value.root, [`dev-db-${action}`], value.environment)
          .status,
      ).toBe(0);
    }
  });

  it('selects a named database package even when packages/db contains a conflicting URL', () => {
    const value = fixture();
    selectWorkspace(value, 'packages/storage');
    writeWorkspace(value.root, 'packages/storage');
    write(
      value.root,
      'packages/db/.env.local',
      'DATABASE_URL=postgres://wrong:wrong@example.com/wrong\n',
    );
    expect(run(value, 'dev-db-start').status).toBe(0);
  });

  it('reports the selected missing env file and never falls back to packages/db', () => {
    const value = fixture();
    selectWorkspace(value, 'apps/web');
    writeWorkspace(value.root, 'apps/web');
    rmSync(join(value.root, 'apps/web/.env.local'));
    const result = run(value, 'dev-db-start');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('apps/web/.env.local not found');
    expect(result.stderr).toContain('just dev-env-generate');
    expect(calls(value)).toBe('');
  });

  it('explains how to select the owner when the default workspace does not exist', () => {
    const value = fixture();
    rmSync(join(value.root, 'packages'), { recursive: true });
    const result = run(value, 'dev-db-start');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Set devDatabase.workspace');
    expect(calls(value)).toBe('');
  });
});

describe('dev database workspace validation', () => {
  it('rejects invalid, escaping, and nonexistent workspace paths before Podman', () => {
    for (const workspace of [
      null,
      2,
      '',
      '.',
      '..',
      '/tmp/db',
      '../db',
      'apps/../db',
      'apps/web/../../db',
      'apps//web',
      'apps/web/',
      'apps\\web',
      'apps/missing',
      'packages/db/.env.local',
    ]) {
      const value = fixture();
      selectWorkspace(value, workspace);
      const result = run(value, 'dev-db-start');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('devDatabase.workspace');
      expect(calls(value)).toBe('');
    }
  });

  it('rejects symlinked workspace directories, manifests, and env files', () => {
    for (const target of ['workspace', 'package.json', '.env.local']) {
      const value = fixture();
      selectWorkspace(value, 'apps/web');
      writeWorkspace(value.root, 'apps/web');
      const outside = mkTmp('dev-db-outside-');
      writeWorkspace(outside, 'db');
      const suffix = target === 'workspace' ? '' : `/${target}`;
      const destination = join(value.root, `apps/web${suffix}`);
      rmSync(destination, { recursive: true });
      symlinkSync(join(outside, `db${suffix}`), destination);
      const result = run(value, 'dev-db-start');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('without symlinks');
      expect(calls(value)).toBe('');
    }
  });

  it('does not read DATABASE_URL from the shell or automatically loaded root dotenv files', () => {
    const value = fixture();
    selectWorkspace(value, 'apps/web');
    writeWorkspace(value.root, 'apps/web');
    write(value.root, 'apps/web/.env.local', 'OTHER=value\n');
    write(value.root, '.env', `DATABASE_URL=${JSON.stringify(databaseUrl)}\n`);
    write(
      value.root,
      '.env.local',
      `DATABASE_URL=${JSON.stringify(databaseUrl)}\n`,
    );
    const result = run(value, 'dev-db-start');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'apps/web/.env.local declares no DATABASE_URL',
    );
    expect(calls(value)).toBe('');
  });

  it('can stop and inspect a managed container after the workspace was removed', () => {
    const value = fixture();
    selectWorkspace(value, 'apps/web');
    present(value);
    expect(run(value, 'dev-db-status').status).toBe(0);
    expect(run(value, 'dev-db-stop').status).toBe(0);
  });
});

describe('dev database CLI routing', () => {
  it('supports --dir and advertises the command in help', () => {
    const value = fixture();
    const result = runProcess(
      'bun',
      ACTUAL_UPSTREAM,
      [cli, 'dev-db', 'start', '--dir', value.root],
      value.environment,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('acme-dev-postgres is running');
    expect(
      runProcess('bun', value.root, [cli, 'help'], value.environment).stdout,
    ).toContain('dev-db');
    expect(
      runProcess('bun', value.root, [cli, 'dev-db', 'help'], value.environment)
        .stdout,
    ).toContain('devDatabase.workspace');
  });

  it('reports a missing Podman executable as an operation failure', () => {
    const value = fixture();
    const bin = join(value.root, 'bin');
    rmSync(join(bin, 'podman'));
    symlinkSync(process.execPath, join(bin, 'bun'));
    const pathVariable = 'PATH';
    const result = runProcess('bun', value.root, [cli, 'dev-db', 'status'], {
      ...value.environment,
      [pathVariable]: bin,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'Unable to determine whether container acme-dev-postgres exists',
    );
    expect(result.stderr).toContain('Executable not found');
    expect(calls(value)).toBe('');
  });

  it('rejects missing actions, unknown actions, unsupported options, and extra arguments', () => {
    for (const args of [
      [],
      ['restart'],
      ['start', '--dir'],
      ['start', '--dir', '--help'],
      ['start', '--force'],
      ['start', 'extra'],
      ['start', '--dir', '.', 'extra'],
    ]) {
      const value = fixture();
      const result = runProcess(
        'bun',
        value.root,
        [cli, 'dev-db', ...args],
        value.environment,
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Usage: standards dev-db');
      expect(calls(value)).toBe('');
    }
  });
});

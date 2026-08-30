import { afterEach, describe, expect, it } from 'bun:test';
import process from 'node:process';
import { cleanupTmpDirs } from './cli-test-support';
import {
  calls,
  control,
  createFixture,
  expectedReadinessArguments,
  expectedRunArguments,
  inspectedOnly,
  managed,
  present,
  readinessAttempts,
  run,
  runFakePodman,
  transientAttempts,
} from './dev-db-just-test-support';

const fixture = (
  packageName = '@standards/root',
  databaseUrl = 'postgres://file-user:file-pass@localhost:5440/file-db',
  postgresVersion?: string,
) => createFixture(packageName, databaseUrl, process.env, postgresVersion);

afterEach(cleanupTmpDirs);

describe('canonical dev database managed lifecycle', () => {
  it('handles names, running and stopped reuse, stop, status, and absence', () => {
    for (const packageName of ['@acme/root', 'acme']) {
      const value = fixture(packageName);
      expect(run(value, 'dev-db-status').status).toBe(0);
    }
    const running = fixture();
    present(running);
    expect(run(running, 'dev-db-start').status).toBe(0);
    expect(calls(running)).not.toContain(
      JSON.stringify(['start', running.name]),
    );
    const stopped = fixture();
    present(stopped, managed(stopped.name, false));
    expect(run(stopped, 'dev-db-start').status).toBe(0);
    expect(calls(stopped)).toContain(JSON.stringify(['start', stopped.name]));
    expect(run(stopped, 'dev-db-stop').stdout).toContain('stopped');
    for (const action of ['dev-db-stop', 'dev-db-status']) {
      const absent = fixture();
      expect(run(absent, action).status).toBe(0);
      expect(calls(absent)).toBe(
        `${JSON.stringify(['container', 'exists', absent.name])}\n`,
      );
    }
  });

  it('refuses every managed-shape mismatch through every public action', () => {
    const mismatches =
      '"Labels":{"io.davidvornholt.standards.dev-db":"true"}~"Labels":{}|"ImageName":"docker.io/library/postgres:17"~"ImageName":"docker.io/library/postgres:16"|"HostIp":"127.0.0.1"~"HostIp":"0.0.0.0"|"HostPort":"5440"~"HostPort":"0"|"Name":"standards-dev-postgres-data"~"Name":"other-data"|"Destination":"/var/lib/postgresql/data"~"Destination":"/wrong"'.split(
        '|',
      );
    for (const mismatch of mismatches) {
      for (const action of ['dev-db-start', 'dev-db-stop', 'dev-db-status']) {
        const [expected = '', replacement = ''] = mismatch.split('~');
        const value = fixture();
        present(value, managed(value.name).replace(expected, replacement));
        expect(run(value, action).status).not.toBe(0);
        expect(calls(value)).toBe(inspectedOnly(value));
      }
    }
  });
});

describe('canonical dev database failures and readiness', () => {
  it('rejects option and value pairs combined into one argument', () => {
    const value = fixture();
    const runArguments = [...expectedRunArguments(value.name)];
    runArguments.splice(
      runArguments.indexOf('-e'),
      2,
      '-e POSTGRES_USER=file-user',
    );
    const runResult = runFakePodman(value, runArguments);
    expect(runResult.status).not.toBe(0);
    expect(runResult.stderr).toContain('unexpected Podman argument array');
    const readinessArguments = [...expectedReadinessArguments(value.name)];
    readinessArguments.splice(
      readinessArguments.indexOf('--host'),
      2,
      '--host 127.0.0.1',
    );
    const readinessResult = runFakePodman(value, readinessArguments);
    expect(readinessResult.status).not.toBe(0);
    expect(readinessResult.stderr).toContain(
      'unexpected Podman argument array',
    );
  });

  it('fails closed when absence checks error', () => {
    for (const action of ['dev-db-start', 'dev-db-stop', 'dev-db-status']) {
      const value = fixture();
      control(value, 'exists-error');
      expect(run(value, action).status).not.toBe(0);
      expect(calls(value)).toBe(
        `${JSON.stringify(['container', 'exists', value.name])}\n`,
      );
    }
  });

  it('fails closed before mutation when inspection errors or is malformed', () => {
    for (const failure of ['inspect-error', 'malformed-inspect']) {
      const value = fixture();
      present(value);
      if (failure === 'malformed-inspect') {
        control(value, 'inspect.json', '{broken');
      } else {
        control(value, failure);
      }
      expect(run(value, 'dev-db-start').status).not.toBe(0);
      expect(calls(value)).toBe(inspectedOnly(value));
    }
  });

  it('fails closed when create, start, or stop errors', () => {
    for (const failure of ['run-error', 'start-error', 'stop-error']) {
      const value = fixture();
      if (failure !== 'run-error') {
        present(value, managed(value.name, failure !== 'start-error'));
      }
      control(value, failure);
      const action = failure === 'stop-error' ? 'dev-db-stop' : 'dev-db-start';
      expect(run(value, action).status).not.toBe(0);
      expect(calls(value)).not.toContain('"exec","--env","PGPASSWORD"');
    }
  });

  it('verifies transient success and authenticated timeout failures', () => {
    const transient = fixture();
    present(transient);
    control(transient, 'transient', '2');
    expect(run(transient, 'dev-db-start').status).toBe(0);
    expect(
      calls(transient).match(/"exec","--env","PGPASSWORD"/gu),
    ).toHaveLength(transientAttempts);
    for (const reason of 'password authentication failed|role does not exist|database does not exist|server is starting'.split(
      '|',
    )) {
      const value = fixture();
      present(value);
      control(value, 'readiness-error', reason);
      const result = run(value, 'dev-db-start');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(reason);
      expect(calls(value).match(/"exec","--env","PGPASSWORD"/gu)).toHaveLength(
        readinessAttempts,
      );
    }
  });
});

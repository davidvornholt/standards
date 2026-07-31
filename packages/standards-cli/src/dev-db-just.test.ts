import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import {
  ACTUAL_UPSTREAM,
  cleanupTmpDirs,
  mkTmp,
  type RunResult,
  runProcess,
  write,
} from './cli-test-support';

const executableMode = 0o755;
const justfile = join(ACTUAL_UPSTREAM, 'justfile');
const secretsJust = join(ACTUAL_UPSTREAM, 'secrets.just');
const readinessAttempts = 30;
const databaseUrlVariable = 'DATABASE_URL';
const fakeRootVariable = 'FAKE_PODMAN_ROOT';
const pathVariable = 'PATH';
const scopedPackagePattern = /^@(?<scope>[^/]+)\//u;

type Fixture = {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly name: string;
  readonly root: string;
};

const managed = (name: string, port = '5440', running = true): string =>
  `{"Config":{"Image":"docker.io/library/postgres:17","Labels":{"io.davidvornholt.standards.dev-db":"true"}},"HostConfig":{"PortBindings":{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"${port}"}]}},"ImageName":"docker.io/library/postgres:17","Mounts":[{"Destination":"/var/lib/postgresql/data","Name":"${name}-data","Type":"volume"}],"State":{"Running":${running},"Status":"running"}}`;

const fakePodman = `#!/bin/sh
set -u; printf '%s\n' "$*" >> "$FAKE_PODMAN_ROOT/calls.log"
case "$1 $2" in
'container exists') if [ -f "$FAKE_PODMAN_ROOT/control/exists-error" ]; then echo 'runtime unavailable' >&2; exit 125; fi; [ -f "$FAKE_PODMAN_ROOT/control/present" ]; exit $? ;;
'container inspect') if [ -f "$FAKE_PODMAN_ROOT/control/inspect-error" ]; then echo 'inspect unavailable' >&2; exit 125; fi; cat "$FAKE_PODMAN_ROOT/control/inspect.json"; exit 0 ;;
esac
case "$1" in
run) if [ -f "$FAKE_PODMAN_ROOT/control/run-error" ]; then echo 'create failed' >&2; exit 125; fi; touch "$FAKE_PODMAN_ROOT/control/present" ;;
start|stop) if [ -f "$FAKE_PODMAN_ROOT/control/$1-error" ]; then echo "$1 failed" >&2; exit 125; fi ;;
exec) printf 'PGPASSWORD=%s\n' "\${PGPASSWORD:-}" >> "$FAKE_PODMAN_ROOT/calls.log"; if [ -f "$FAKE_PODMAN_ROOT/control/readiness-error" ]; then cat "$FAKE_PODMAN_ROOT/control/readiness-error" >&2; exit 2; fi; echo 1 ;;
esac
`;

const fixture = (
  packageName = '@standards/root',
  databaseUrl = 'postgres://file-user:file-pass@localhost:5440/file-db',
): Fixture => {
  const basePath = process.env.PATH;
  if (basePath === undefined) {
    throw new Error('test environment must define PATH');
  }
  const root = mkTmp('dev-db-just-');
  const bin = join(root, 'bin');
  const repo =
    scopedPackagePattern.exec(packageName)?.groups?.scope ?? packageName;
  const name = `${repo}-dev-postgres`;
  mkdirSync(bin);
  write(root, 'justfile', readFileSync(justfile, 'utf8'));
  write(root, 'secrets.just', readFileSync(secretsJust, 'utf8'));
  write(root, 'package.json', `${JSON.stringify({ name: packageName })}\n`);
  write(root, 'packages/db/.env.local', `DATABASE_URL=${databaseUrl}\n`);
  write(root, 'control/inspect.json', `[${managed(name)}]`);
  write(root, 'bin/podman', fakePodman);
  write(root, 'bin/sleep', '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'podman'), executableMode);
  chmodSync(join(bin, 'sleep'), executableMode);
  return {
    environment: {
      ...process.env,
      [databaseUrlVariable]: 'postgres://x:x@localhost:1/x',
      [fakeRootVariable]: root,
      [pathVariable]: `${bin}:${basePath}`,
    },
    name,
    root,
  };
};

const run = (value: Fixture, action: string): RunResult =>
  runProcess(
    'just',
    value.root,
    ['--color', 'never', action],
    value.environment,
  );
const calls = (value: Fixture): string =>
  existsSync(join(value.root, 'calls.log'))
    ? readFileSync(join(value.root, 'calls.log'), 'utf8')
    : '';
const control = (value: Fixture, name: string, content = ''): void =>
  write(value.root, `control/${name}`, content);
const inspect = (value: Fixture, shape: string): void =>
  control(value, 'inspect.json', `[${shape}]`);

afterEach(cleanupTmpDirs);

describe('canonical dev database Just recipes', () => {
  it('creates from the generated file for each supported IPv4 host', () => {
    for (const host of ['LOCALHOST', '127.0.0.1']) {
      const value = fixture(
        '@acme/root',
        `postgres://file-user:file-pass@${host}:5440/file-db`,
      );
      expect(run(value, 'dev-db-start').status).toBe(0);
      expect(calls(value)).toContain(
        'POSTGRES_USER=file-user -e POSTGRES_PASSWORD=file-pass -e POSTGRES_DB=file-db',
      );
      expect(calls(value)).toContain('-p 127.0.0.1:5440:5432');
      expect(calls(value)).not.toContain('ambient');
      expect(calls(value)).toContain('PGPASSWORD=file-pass');
    }
  });

  it('rejects bad connections and package metadata before Podman', () => {
    const invalidUrls =
      'http://u:p@localhost:5440/db|postgres://u:p@[::1]:5440/db|postgres://u:p@localhost:0/db|postgres://:p@localhost:5440/db|postgres://u@localhost:5440/db|postgres://u:p@localhost:5440/|postgres://%ZZ:p@localhost:5440/db|postgres://u:p@example.com:5440/db'.split(
        '|',
      );
    for (const databaseUrl of invalidUrls) {
      const value = fixture('acme', databaseUrl);
      expect(run(value, 'dev-db-start').status).not.toBe(0);
      expect(calls(value)).toBe('');
    }
    for (const manifest of '{}|{"name":2}|{"name":"bad/name"}|{broken'.split(
      '|',
    )) {
      const value = fixture();
      write(value.root, 'package.json', manifest);
      expect(run(value, 'dev-db-status').status).not.toBe(0);
      expect(calls(value)).toBe('');
    }
  });
});

describe('canonical dev database lifecycle', () => {
  it('derives names and handles create, reuse, stop, status, and absence', () => {
    for (const packageName of ['@acme/root', 'acme']) {
      const value = fixture(packageName);
      expect(run(value, 'dev-db-status').status).toBe(0);
      expect(calls(value)).toContain('container exists acme-dev-postgres');
    }
    const running = fixture();
    control(running, 'present');
    expect(run(running, 'dev-db-start').status).toBe(0);
    expect(calls(running)).not.toContain(`start ${running.name}`);
    const stopped = fixture();
    control(stopped, 'present');
    inspect(stopped, managed(stopped.name, '5440', false));
    expect(run(stopped, 'dev-db-start').status).toBe(0);
    expect(calls(stopped)).toContain(`start ${stopped.name}`);
    expect(run(stopped, 'dev-db-stop').stdout).toContain('stopped');
    for (const action of ['dev-db-stop', 'dev-db-status']) {
      const absent = fixture();
      expect(run(absent, action).status).toBe(0);
      expect(calls(absent)).toBe(`container exists ${absent.name}\n`);
    }
  });

  it('refuses every ownership, image, listener, port, and volume mismatch', () => {
    const mismatches =
      '"Labels":{"io.davidvornholt.standards.dev-db":"true"}~"Labels":{}|"ImageName":"docker.io/library/postgres:17"~"ImageName":"docker.io/library/postgres:16"|"HostIp":"127.0.0.1"~"HostIp":"0.0.0.0"|"HostPort":"5440"~"HostPort":"5441"|"Name":"standards-dev-postgres-data"~"Name":"other-data"'.split(
        '|',
      );
    for (const mismatch of mismatches) {
      const [expected = '', replacement = ''] = mismatch.split('~');
      const value = fixture();
      control(value, 'present');
      inspect(value, managed(value.name).replace(expected, replacement));
      expect(run(value, 'dev-db-start').status).not.toBe(0);
      expect(calls(value)).not.toContain('exec --env PGPASSWORD');
    }
  });

  it('fails closed on Podman and authenticated readiness errors', () => {
    for (const action of ['dev-db-start', 'dev-db-stop', 'dev-db-status']) {
      const value = fixture();
      control(value, 'exists-error');
      const result = run(value, action);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('runtime unavailable');
    }
    const failures = [
      ['run-error', 'dev-db-start', false],
      ['stop-error', 'dev-db-stop', true],
    ] as const;
    for (const [failure, action, present] of failures) {
      const value = fixture();
      control(value, failure);
      if (present) {
        control(value, 'present');
      }
      expect(run(value, action).status).not.toBe(0);
    }
    for (const reason of 'password authentication failed|role does not exist|database does not exist|server is starting'.split(
      '|',
    )) {
      const value = fixture();
      control(value, 'present');
      control(value, 'readiness-error', reason);
      const result = run(value, 'dev-db-start');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(reason);
      expect(calls(value).match(/exec --env PGPASSWORD/gu)).toHaveLength(
        readinessAttempts,
      );
    }
  });
});

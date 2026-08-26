import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTUAL_UPSTREAM, mkTmp, runProcess, write } from './cli-test-support';

const executableMode = 0o755;
const scopedPackagePattern = /^@(?<scope>[^/]+)\//u;
const databaseUrlVariable = 'DATABASE_URL';
const fakeRootVariable = 'FAKE_PODMAN_ROOT';
const pathVariable = 'PATH';
const passwordVariable = 'PGPASSWORD';
const canonicalSleep = 'await Bun.sleep(1000);';

export const readinessAttempts = 30;
export const transientAttempts = 3;
export const defaultPostgresVersion = '17';
const parentDataLayoutVersion = 18;

export const dataDestination = (postgresVersion: string) =>
  Number(postgresVersion) >= parentDataLayoutVersion
    ? '/var/lib/postgresql'
    : '/var/lib/postgresql/data';

export const managed = (
  name: string,
  running = true,
  postgresVersion = defaultPostgresVersion,
): string =>
  `{"Config":{"Image":"docker.io/library/postgres:${postgresVersion}","Labels":{"io.davidvornholt.standards.dev-db":"true"}},"HostConfig":{"PortBindings":{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"5440"}]}},"ImageName":"docker.io/library/postgres:${postgresVersion}","Mounts":[{"Destination":"${dataDestination(postgresVersion)}","Name":"${name}-data","Type":"volume"}],"State":{"Running":${running},"Status":"running"}}`;

export const expectedRunArguments = (
  name: string,
  postgresVersion = defaultPostgresVersion,
): ReadonlyArray<string> => [
  'run',
  '-d',
  '--name',
  name,
  '--label',
  'io.davidvornholt.standards.dev-db=true',
  '-e',
  'POSTGRES_USER=file-user',
  '-e',
  'POSTGRES_PASSWORD=file-pass',
  '-e',
  'POSTGRES_DB=file-db',
  '-p',
  '127.0.0.1:5440:5432',
  '-v',
  `${name}-data:${dataDestination(postgresVersion)}`,
  `docker.io/library/postgres:${postgresVersion}`,
];

export const expectedReadinessArguments = (
  name: string,
): ReadonlyArray<string> => [
  'exec',
  '--env',
  'PGPASSWORD',
  name,
  'psql',
  '--host',
  '127.0.0.1',
  '--port',
  '5432',
  '--username',
  'file-user',
  '--dbname',
  'file-db',
  '--no-password',
  '--no-psqlrc',
  '--tuples-only',
  '--no-align',
  '--command',
  'SELECT 1',
];

const fakePodman = (
  name: string,
  postgresVersion: string,
): string => `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.FAKE_PODMAN_ROOT ?? '';
const args = process.argv.slice(2);
const path = (name) => join(root, 'control', name);
const present = (name) => existsSync(path(name));
const same = (expected) => JSON.stringify(args) === JSON.stringify(expected);
const fail = (message, status = 64) => { console.error(message); process.exit(status); };
appendFileSync(join(root, 'calls.log'), JSON.stringify(args) + '\\n');
if (same(['container', 'exists', ${JSON.stringify(name)}])) {
  if (present('exists-error')) fail('runtime unavailable', 125);
  process.exit(present('present') ? 0 : 1);
}
if (same(['container', 'inspect', ${JSON.stringify(name)}])) {
  if (present('inspect-error')) fail('inspect unavailable', 125);
  process.stdout.write(readFileSync(path('inspect.json'), 'utf8'));
  process.exit(0);
}
if (same(${JSON.stringify(expectedRunArguments(name, postgresVersion))})) {
  if (present('run-error')) fail('create failed', 125);
  writeFileSync(path('present'), '');
  process.exit(0);
}
for (const action of ['start', 'stop']) {
  if (same([action, ${JSON.stringify(name)}])) {
    if (present(action + '-error')) fail(action + ' failed', 125);
    process.exit(0);
  }
}
if (same(${JSON.stringify(expectedReadinessArguments(name))})) {
  if (process.env.PGPASSWORD !== 'file-pass') fail('unexpected readiness password');
  if (present('readiness-error')) fail(readFileSync(path('readiness-error'), 'utf8'), 2);
  if (present('transient')) {
    const remaining = Number(readFileSync(path('transient'), 'utf8'));
    if (remaining > 0) {
      writeFileSync(path('transient'), String(remaining - 1));
      fail('server is starting', 2);
    }
  }
  console.log('1');
  process.exit(0);
}
fail('unexpected Podman argument array');
`;

export const createFixture = (
  packageName: string,
  databaseUrl: string,
  baseEnvironment: Readonly<Record<string, string | undefined>>,
  postgresVersion = defaultPostgresVersion,
) => {
  const root = mkTmp('dev-db-just-');
  const bin = join(root, 'bin');
  const repo =
    scopedPackagePattern.exec(packageName)?.groups?.scope ?? packageName;
  const name = `${repo}-dev-postgres`;
  const source = readFileSync(join(ACTUAL_UPSTREAM, 'justfile'), 'utf8');
  if (source.split(canonicalSleep).length !== 2) {
    throw new Error('canonical Bun.sleep statement must occur exactly once');
  }
  write(
    root,
    'justfile',
    source.replace(canonicalSleep, 'await Bun.sleep(0);'),
  );
  write(
    root,
    'secrets.just',
    readFileSync(join(ACTUAL_UPSTREAM, 'secrets.just'), 'utf8'),
  );
  write(
    root,
    'package.json',
    `${JSON.stringify({ devDatabase: { postgresVersion }, name: packageName })}\n`,
  );
  write(
    root,
    'packages/db/.env.local',
    `DATABASE_URL=${JSON.stringify(databaseUrl)}\n`,
  );
  write(
    root,
    'control/inspect.json',
    `[${managed(name, true, postgresVersion)}]`,
  );
  write(root, 'control/name', name);
  write(root, 'bin/podman', fakePodman(name, postgresVersion));
  chmodSync(join(bin, 'podman'), executableMode);
  return {
    environment: {
      ...baseEnvironment,
      [databaseUrlVariable]: 'postgres://x:x@localhost:1/x',
      [fakeRootVariable]: root,
      [pathVariable]: `${bin}:${baseEnvironment.PATH ?? ''}`,
    },
    name,
    postgresVersion,
    root,
  };
};

export type Fixture = ReturnType<typeof createFixture>;

export const run = (value: Fixture, action: string) =>
  runProcess('just', value.root, [action], value.environment);

export const calls = (value: Fixture): string =>
  existsSync(join(value.root, 'calls.log'))
    ? readFileSync(join(value.root, 'calls.log'), 'utf8')
    : '';

export const control = (value: Fixture, name: string, content = ''): void =>
  write(value.root, `control/${name}`, content);

export const present = (
  value: Fixture,
  shape = managed(value.name, true, value.postgresVersion),
): void => {
  control(value, 'present');
  control(value, 'inspect.json', `[${shape}]`);
};

export const rejectedBeforePodman = (value: Fixture): boolean =>
  run(value, 'dev-db-start').status !== 0 && calls(value) === '';

export const inspectedOnly = (value: Fixture): string =>
  `${JSON.stringify(['container', 'exists', value.name])}\n${JSON.stringify(['container', 'inspect', value.name])}\n`;

export const runFakePodman = (
  value: Fixture,
  arguments_: ReadonlyArray<string>,
) =>
  runProcess(join(value.root, 'bin/podman'), value.root, arguments_, {
    ...value.environment,
    [passwordVariable]: 'file-pass',
  });

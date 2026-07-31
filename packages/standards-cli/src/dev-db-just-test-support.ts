import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTUAL_UPSTREAM, mkTmp, runProcess, write } from './cli-test-support';

const executableMode = 0o755;
const scopedPackagePattern = /^@(?<scope>[^/]+)\//u;
const databaseUrlVariable = 'DATABASE_URL';
const fakeRootVariable = 'FAKE_PODMAN_ROOT';
const pathVariable = 'PATH';
const canonicalSleep = 'await Bun.sleep(1000);';

export const readinessAttempts = 30;
export const transientAttempts = 3;

export const managed = (name: string, running = true): string =>
  `{"Config":{"Image":"docker.io/library/postgres:17","Labels":{"io.davidvornholt.standards.dev-db":"true"}},"HostConfig":{"PortBindings":{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"5440"}]}},"ImageName":"docker.io/library/postgres:17","Mounts":[{"Destination":"/var/lib/postgresql/data","Name":"${name}-data","Type":"volume"}],"State":{"Running":${running},"Status":"running"}}`;

const fakePodman = `#!/bin/sh
set -u; printf '%s\n' "$*" >> "$FAKE_PODMAN_ROOT/calls.log"; name="$(cat "$FAKE_PODMAN_ROOT/control/name")"; case "$1 $2" in 'container exists') [ "$3" = "$name" ] || exit 64; if [ -f "$FAKE_PODMAN_ROOT/control/exists-error" ]; then echo 'runtime unavailable' >&2; exit 125; fi; [ -f "$FAKE_PODMAN_ROOT/control/present" ]; exit $? ;; 'container inspect') [ "$3" = "$name" ] || exit 64; if [ -f "$FAKE_PODMAN_ROOT/control/inspect-error" ]; then echo 'inspect unavailable' >&2; exit 125; fi; cat "$FAKE_PODMAN_ROOT/control/inspect.json"; exit 0 ;; esac
case "$1" in run) [ "$*" = "run -d --name $name --label io.davidvornholt.standards.dev-db=true -e POSTGRES_USER=file-user -e POSTGRES_PASSWORD=file-pass -e POSTGRES_DB=file-db -p 127.0.0.1:5440:5432 -v $name-data:/var/lib/postgresql/data docker.io/library/postgres:17" ] || { echo 'unexpected run command' >&2; exit 64; }; if [ -f "$FAKE_PODMAN_ROOT/control/run-error" ]; then echo 'create failed' >&2; exit 125; fi; touch "$FAKE_PODMAN_ROOT/control/present" ;; start|stop) [ "$*" = "$1 $name" ] || exit 64; if [ -f "$FAKE_PODMAN_ROOT/control/$1-error" ]; then echo "$1 failed" >&2; exit 125; fi ;; exec) [ "$*" = "exec --env PGPASSWORD $name psql --host 127.0.0.1 --port 5432 --username file-user --dbname file-db --no-password --no-psqlrc --tuples-only --no-align --command SELECT 1" ] || { echo 'unexpected readiness command' >&2; exit 64; }; [ "\${PGPASSWORD:-}" = 'file-pass' ] || { echo 'unexpected readiness password' >&2; exit 64; }; if [ -f "$FAKE_PODMAN_ROOT/control/readiness-error" ]; then cat "$FAKE_PODMAN_ROOT/control/readiness-error" >&2; exit 2; fi; if [ -f "$FAKE_PODMAN_ROOT/control/transient" ] && [ "$(cat "$FAKE_PODMAN_ROOT/control/transient")" -gt 0 ]; then count="$(cat "$FAKE_PODMAN_ROOT/control/transient")"; echo $((count - 1)) > "$FAKE_PODMAN_ROOT/control/transient"; echo 'server is starting' >&2; exit 2; fi; echo 1 ;; esac`;

export const createFixture = (
  packageName: string,
  databaseUrl: string,
  baseEnvironment: Readonly<Record<string, string | undefined>>,
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
  write(root, 'package.json', `${JSON.stringify({ name: packageName })}\n`);
  write(
    root,
    'packages/db/.env.local',
    `DATABASE_URL=${JSON.stringify(databaseUrl)}\n`,
  );
  write(root, 'control/inspect.json', `[${managed(name)}]`);
  write(root, 'control/name', name);
  write(root, 'bin/podman', fakePodman);
  chmodSync(join(bin, 'podman'), executableMode);
  return {
    environment: {
      ...baseEnvironment,
      [databaseUrlVariable]: 'postgres://x:x@localhost:1/x',
      [fakeRootVariable]: root,
      [pathVariable]: `${bin}:${baseEnvironment.PATH ?? ''}`,
    },
    name,
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

export const present = (value: Fixture, shape = managed(value.name)): void => {
  control(value, 'present');
  control(value, 'inspect.json', `[${shape}]`);
};

export const rejectedBeforePodman = (value: Fixture): boolean =>
  run(value, 'dev-db-start').status !== 0 && calls(value) === '';

export const inspectedOnly = (value: Fixture): string =>
  `container exists ${value.name}\ncontainer inspect ${value.name}\n`;

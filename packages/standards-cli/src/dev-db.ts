import { spawnSync } from 'node:child_process';
import {
  type Connection,
  isUsablePort,
  readConnection,
  readDevDbManifest,
  readPostgresVersion,
} from './dev-db-config';
import { isRecord } from './github-settings-parse';

const passwordVariable = 'PGPASSWORD';
const ownershipLabel = 'io.davidvornholt.standards.dev-db';
const parentDataLayoutVersion = 18;
const readinessAttempts = 30;
const readinessDelay = 1000;

type Action = 'start' | 'stop' | 'status';
type Environment = Readonly<Record<string, string | undefined>>;
type PodmanResult = ReturnType<typeof spawnSync>;
type Shape = {
  readonly name: string;
  readonly volume: string;
  readonly image: string;
  readonly dataDestination: string;
};

const detail = (result: PodmanResult): string =>
  result.error?.message ||
  result.stderr?.toString().trim() ||
  result.stdout?.toString().trim() ||
  `exit ${result.status}`;

const podmanFailed = (operation: string, result: PodmanResult): never => {
  throw new Error(`${operation}: ${detail(result)}`);
};

const field = (value: unknown, key: string): unknown =>
  isRecord(value) ? value[key] : undefined;
const text = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback;

const makePodman =
  (consumer: string, environment: Environment) =>
  (args: ReadonlyArray<string>, password?: string) =>
    spawnSync('podman', args, {
      cwd: consumer,
      env:
        password === undefined
          ? environment
          : { ...environment, [passwordVariable]: password },
    });
type Podman = ReturnType<typeof makePodman>;

const exists = (podman: Podman, name: string): boolean => {
  const result = podman(['container', 'exists', name]);
  if (result.status === 0) {
    return true;
  }
  if (result.status === 1) {
    return false;
  }
  return podmanFailed(
    `Unable to determine whether container ${name} exists`,
    result,
  );
};

const parseContainer = (result: PodmanResult, name: string): unknown => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.toString()) as unknown;
  } catch (cause) {
    throw new Error(`Unable to parse Podman inspection for ${name}.`, {
      cause,
    });
  }
  return Array.isArray(parsed) ? parsed[0] : undefined;
};

const inspectManaged = (
  podman: Podman,
  shape: Shape,
  action: Action,
  expectedPort?: string,
) => {
  const { name, volume, image, dataDestination } = shape;
  const result = podman(['container', 'inspect', name]);
  if (result.status !== 0) {
    podmanFailed(`Unable to inspect container ${name}`, result);
  }
  const container = parseContainer(result, name);
  const config = field(container, 'Config');
  const bindings = field(
    field(field(container, 'HostConfig'), 'PortBindings'),
    '5432/tcp',
  );
  const binding: unknown =
    Array.isArray(bindings) && bindings.length === 1 ? bindings[0] : undefined;
  const port = field(binding, 'HostPort');
  const currentImage = field(container, 'ImageName') ?? field(config, 'Image');
  const mounts = field(container, 'Mounts');
  const dataMount: unknown = Array.isArray(mounts)
    ? mounts.find(
        (mount: unknown) => field(mount, 'Destination') === dataDestination,
      )
    : undefined;
  const mismatches: Array<string> = [];
  if (field(field(config, 'Labels'), ownershipLabel) !== 'true') {
    mismatches.push(`missing ${ownershipLabel}=true ownership label`);
  }
  if (currentImage !== image) {
    mismatches.push(
      `image is ${text(currentImage, 'unreadable')} rather than ${image}`,
    );
  }
  if (field(binding, 'HostIp') !== '127.0.0.1') {
    mismatches.push('PostgreSQL is not bound exactly once to 127.0.0.1');
  }
  if (!isUsablePort(port)) {
    mismatches.push('published PostgreSQL port is unusable');
  }
  if (expectedPort !== undefined && port !== expectedPort) {
    mismatches.push(
      `published port ${text(port, 'none')} does not match DATABASE_URL port ${expectedPort}`,
    );
  }
  if (
    field(dataMount, 'Type') !== 'volume' ||
    field(dataMount, 'Name') !== volume
  ) {
    mismatches.push(`data mount is not the ${volume} named volume`);
  }
  const versionAdvice =
    currentImage === image
      ? ''
      : ` A PostgreSQL major version cannot read another major version's data directory. After confirming the local data may be discarded, remove the old container and volume: podman rm -f ${name} && podman volume rm ${volume}.`;
  if (mismatches.length > 0) {
    throw new Error(
      `Container ${name} does not match the canonical dev-db shape: ${mismatches.join('; ')}. Refusing to ${action} it.${versionAdvice}`,
    );
  }
  const state = field(container, 'State');
  return {
    running: field(state, 'Running') === true,
    status: text(field(state, 'Status'), 'unknown'),
    port: text(port, ''),
  };
};

const start = async ({
  podman,
  shape,
  connection,
  present,
  sleep,
}: {
  readonly podman: Podman;
  readonly shape: Shape;
  readonly connection: Connection;
  readonly present: boolean;
  readonly sleep: (ms: number) => Promise<unknown>;
}): Promise<string> => {
  const { name, volume, image, dataDestination } = shape;
  if (!present) {
    const created = podman([
      'run',
      '-d',
      '--name',
      name,
      '--label',
      `${ownershipLabel}=true`,
      '-e',
      `POSTGRES_USER=${connection.user}`,
      '-e',
      `POSTGRES_PASSWORD=${connection.password}`,
      '-e',
      `POSTGRES_DB=${connection.database}`,
      '-p',
      `127.0.0.1:${connection.port}:5432`,
      '-v',
      `${volume}:${dataDestination}`,
      image,
    ]);
    if (created.status !== 0) {
      podmanFailed(`Unable to create container ${name}`, created);
    }
  }
  const container = inspectManaged(podman, shape, 'start', connection.port);
  if (!container.running) {
    const started = podman(['start', name]);
    if (started.status !== 0) {
      podmanFailed(`Unable to start container ${name}`, started);
    }
  }
  let lastReadinessError = '';
  for (let attempt = 0; attempt < readinessAttempts; attempt += 1) {
    const verified = podman(
      [
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
        connection.user,
        '--dbname',
        connection.database,
        '--no-password',
        '--no-psqlrc',
        '--tuples-only',
        '--no-align',
        '--command',
        'SELECT 1',
      ],
      connection.password,
    );
    if (verified.status === 0 && verified.stdout.toString().trim() === '1') {
      return `${name} is running and accepts the configured DATABASE_URL on 127.0.0.1:${connection.port}.`;
    }
    lastReadinessError = detail(verified);
    if (attempt < readinessAttempts - 1) {
      // biome-ignore lint/performance/noAwaitInLoops: Readiness retries must wait for PostgreSQL startup before checking again.
      await sleep(readinessDelay);
    }
  }
  throw new Error(
    `${name} started but the configured DATABASE_URL did not become usable${lastReadinessError ? `: ${lastReadinessError}` : ''}. Inspect with: podman logs ${name}`,
  );
};

export const runDevDb = async (
  consumer: string,
  action: Action,
  environment: Environment,
  sleep: (ms: number) => Promise<unknown>,
): Promise<string> => {
  const { name, config } = await readDevDbManifest(consumer);
  const connection =
    action === 'start'
      ? readConnection(consumer, config, environment)
      : undefined;
  const declaredVersion =
    action === 'start' ? readPostgresVersion(config) : undefined;
  const podman = makePodman(consumer, environment);
  const present = exists(podman, name);
  if (!present && action === 'stop') {
    return `No managed container named ${name} exists.`;
  }
  if (!present && action === 'status') {
    return `${name}: not created. Run \`just dev-db-start\`.`;
  }
  const version = declaredVersion ?? readPostgresVersion(config);
  const shape = {
    name,
    volume: `${name}-data`,
    image: `docker.io/library/postgres:${version}`,
    dataDestination:
      Number(version) >= parentDataLayoutVersion
        ? '/var/lib/postgresql'
        : '/var/lib/postgresql/data',
  };
  if (connection !== undefined) {
    return start({ podman, shape, connection, present, sleep });
  }
  const container = inspectManaged(podman, shape, action);
  if (action === 'status') {
    return `${name}: ${container.status} (127.0.0.1:${container.port})`;
  }
  const stopped = podman(['stop', name]);
  if (stopped.status !== 0) {
    podmanFailed(`Unable to stop container ${name}`, stopped);
  }
  return `${name} stopped.`;
};

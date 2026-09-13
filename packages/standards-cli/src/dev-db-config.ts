import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isContainedPath } from './contained-path';
import { isRecord } from './github-settings-parse';
import { readJsonFile } from './json-file';

const safeName = /^[a-z0-9][a-z0-9._-]*$/u;
const scopedNamePattern = /^@(?<scope>[^/]+)\/(?<name>[^/]+)$/u;
const workspacePattern = /^(?:apps|packages)\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;
const majorVersionPattern = /^[1-9]\d*$/u;
const portPattern = /^\d+$/u;
const invalidDecodedValue = /[\0\r\n]/u;
const maximumPort = 65_535;
const databaseUrlVariable = 'DATABASE_URL';

export type Connection = {
  readonly database: string;
  readonly password: string;
  readonly port: string;
  readonly user: string;
};

export const readDevDbManifest = async (consumer: string) => {
  const manifest = await readJsonFile(join(consumer, 'package.json'));
  const packageName = manifest?.name;
  if (typeof packageName !== 'string' || packageName.length === 0) {
    throw new Error(
      'The root package.json must declare a string name to derive the dev database container name.',
    );
  }
  const scopedName = scopedNamePattern.exec(packageName);
  const repo = scopedName?.groups?.scope ?? packageName;
  if (
    !safeName.test(repo) ||
    (scopedName !== null && !safeName.test(scopedName.groups?.name ?? ''))
  ) {
    throw new Error(
      `The root package name ${JSON.stringify(packageName)} cannot produce a safe Podman container name.`,
    );
  }
  return {
    name: `${repo}-dev-postgres`,
    config: isRecord(manifest?.devDatabase) ? manifest.devDatabase : {},
  };
};

export const readPostgresVersion = (
  config: Readonly<Record<string, unknown>>,
): string => {
  const version = config.postgresVersion;
  if (typeof version !== 'string' || !majorVersionPattern.test(version)) {
    throw new Error(
      'The root package.json must declare a PostgreSQL major version as a string, such as "devDatabase": { "postgresVersion": "18" }. Declare the major version your production database runs, so dev and production cannot drift apart.',
    );
  }
  return version;
};

const readEnvFile = (
  consumer: string,
  config: Readonly<Record<string, unknown>>,
): string => {
  const workspace =
    config.workspace === undefined ? 'packages/db' : config.workspace;
  if (typeof workspace !== 'string' || !workspacePattern.test(workspace)) {
    throw new Error(
      'devDatabase.workspace must be a workspace path such as "packages/db" or "apps/web".',
    );
  }
  if (!isContainedPath(consumer, `${workspace}/package.json`, 'file')) {
    throw new Error(
      `${workspace}/package.json must exist inside the repository without symlinks. Set devDatabase.workspace in the root package.json to the workspace that owns DATABASE_URL (default: "packages/db").`,
    );
  }
  const envFile = `${workspace}/.env.local`;
  if (!existsSync(join(consumer, envFile))) {
    throw new Error(
      `${envFile} not found. Run \`just dev-env-generate\` first; if DATABASE_URL belongs to another workspace, set devDatabase.workspace in the root package.json.`,
    );
  }
  if (!isContainedPath(consumer, envFile, 'file')) {
    throw new Error(
      `${envFile} must be a regular file inside the repository without symlinks.`,
    );
  }
  return envFile;
};

const decode = (value: string, field: string): string => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch (cause) {
    throw new Error(
      `DATABASE_URL has invalid percent-encoding in its ${field}.`,
      { cause },
    );
  }
  if (!decoded || invalidDecodedValue.test(decoded)) {
    throw new Error(`DATABASE_URL must declare a usable ${field}.`);
  }
  return decoded;
};

export const isUsablePort = (port: unknown): port is string =>
  typeof port === 'string' &&
  portPattern.test(port) &&
  Number(port) >= 1 &&
  Number(port) <= maximumPort;

export const readConnection = (
  consumer: string,
  config: Readonly<Record<string, unknown>>,
  environment: Readonly<Record<string, string | undefined>>,
): Connection => {
  const envFile = readEnvFile(consumer, config);
  const cleanEnvironment = { ...environment };
  delete cleanEnvironment[databaseUrlVariable];
  // Disabling automatic dotenv loading prevents a root .env from supplying a
  // missing DATABASE_URL. Only the selected generated file owns this value.
  const loaded = spawnSync(
    'bun',
    [
      '--no-env-file',
      `--env-file=${envFile}`,
      '-e',
      'process.stdout.write(process.env.DATABASE_URL ?? "")',
    ],
    { cwd: consumer, env: cleanEnvironment },
  );
  if (loaded.status !== 0) {
    throw new Error(`Unable to read DATABASE_URL from ${envFile}.`);
  }
  const databaseUrl = loaded.stdout.toString();
  if (!databaseUrl) {
    throw new Error(
      `${envFile} declares no DATABASE_URL. Set devDatabase.workspace to the workspace that owns it.`,
    );
  }
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch (cause) {
    throw new Error('DATABASE_URL is not a valid URL.', { cause });
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error(
      'DATABASE_URL must use the postgres: or postgresql: protocol.',
    );
  }
  if (url.search || url.hash) {
    throw new Error(
      'DATABASE_URL must not include query parameters or a fragment; dev-db validates and applies only the URL authority and path.',
    );
  }
  const host = url.hostname.toLowerCase();
  if (host === '[::1]' || host === '::1') {
    throw new Error(
      'DATABASE_URL must use localhost or 127.0.0.1; the managed listener is IPv4 only.',
    );
  }
  if (!['localhost', '127.0.0.1'].includes(host)) {
    throw new Error(
      `DATABASE_URL points at ${url.hostname || 'no host'}; dev-db manages only IPv4 loopback databases.`,
    );
  }
  const port = url.port || '5432';
  if (!isUsablePort(port)) {
    throw new Error(
      'DATABASE_URL must declare a usable TCP port from 1 through 65535.',
    );
  }
  return {
    database: decode(url.pathname.slice(1), 'database name'),
    password: decode(url.password, 'password'),
    port,
    user: decode(url.username, 'user'),
  };
};

set dotenv-load := false

mod secrets 'secrets.just'

# Repo-specific recipes and modules extend this canonical file from a
# repo-owned local.just; this file is synced and must not be edited locally.

import? 'local.just'

default:
    @just --list

# Compose each workspace's .env.local from config/dev.yaml, encrypted secrets/dev.yaml, local overrides, and authorized broker-owned S3 pairs referenced by the plain layers
dev-env-generate:
    bun standards dev-env

# Edit dev secrets, then regenerate the derived dev env files
dev-refresh:
    just secrets edit dev
    just dev-env-generate

# Start (creating on first use) the repo's canonical local dev PostgreSQL container
dev-db-start:
    @just _dev-db-action start

# Stop the repo's canonical local dev PostgreSQL container
dev-db-stop:
    @just _dev-db-action stop

# Show the state of the repo's canonical local dev PostgreSQL container
dev-db-status:
    @just _dev-db-action status

_dev-db-action action:
    #!/usr/bin/env bun
    const action = {{ quote(action) }};
    const envFile = 'packages/db/.env.local';
    const ownershipLabel = 'io.davidvornholt.standards.dev-db';
    const fail = (message) => { console.error(message); process.exit(1); };
    const detail = (result) => result.stderr.toString().trim() || result.stdout.toString().trim() || `exit ${result.exitCode}`;
    const podman = (args, options = {}) => Bun.spawnSync(['podman', ...args], options);
    const podmanFailed = (operation, result) => fail(`${operation}: ${detail(result)}`);
    const safeName = /^[a-z0-9][a-z0-9._-]*$/u;
    let manifest;
    try {
      manifest = JSON.parse(await Bun.file('package.json').text());
    } catch (error) {
      fail(`Unable to read the root package.json: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof manifest?.name !== 'string' || manifest.name.length === 0) fail('The root package.json must declare a string name to derive the dev database container name.');
    const scopedName = /^@([^/]+)\/([^/]+)$/u.exec(manifest.name);
    const repo = scopedName?.[1] ?? manifest.name;
    if (!safeName.test(repo) || (scopedName !== null && !safeName.test(scopedName[2] ?? ''))) fail(`The root package name ${JSON.stringify(manifest.name)} cannot produce a safe Podman container name.`);
    const name = `${repo}-dev-postgres`;
    const volume = `${name}-data`;
    const readPostgresVersion = () => {
      const postgresVersion = manifest?.devDatabase?.postgresVersion;
      if (typeof postgresVersion !== 'string' || !/^[1-9]\d*$/u.test(postgresVersion)) fail('The root package.json must declare a PostgreSQL major version as a string, such as "devDatabase": { "postgresVersion": "18" }. Declare the major version your production database runs, so dev and production cannot drift apart.');
      return postgresVersion;
    };
    const decode = (value, field) => {
      try {
        const decoded = decodeURIComponent(value);
        if (!decoded || /[\0\r\n]/u.test(decoded)) fail(`DATABASE_URL must declare a usable ${field}.`);
        return decoded;
      } catch (error) {
        fail(`DATABASE_URL has invalid percent-encoding in its ${field}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const readConnection = async () => {
      if (!(await Bun.file(envFile).exists())) fail(`${envFile} not found. Run \`just dev-env-generate\` first.`);
      const cleanEnvironment = { ...process.env };
      delete cleanEnvironment.DATABASE_URL;
      const loaded = Bun.spawnSync(['bun', `--env-file=${envFile}`, '-e', 'process.stdout.write(process.env.DATABASE_URL ?? "")'], { env: cleanEnvironment });
      if (loaded.exitCode !== 0) fail(`Unable to read DATABASE_URL from ${envFile}: ${detail(loaded)}`);
      const databaseUrl = loaded.stdout.toString();
      if (!databaseUrl) fail(`${envFile} declares no DATABASE_URL. dev-db manages only repos whose db package uses one.`);
      let url;
      try {
        url = new URL(databaseUrl);
      } catch (error) {
        fail(`DATABASE_URL is not a valid URL: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!['postgres:', 'postgresql:'].includes(url.protocol)) fail('DATABASE_URL must use the postgres: or postgresql: protocol.');
      if (url.search || url.hash) fail('DATABASE_URL must not include query parameters or a fragment; dev-db validates and applies only the URL authority and path.');
      const host = url.hostname.toLowerCase();
      if (host === '[::1]' || host === '::1') fail('DATABASE_URL must use localhost or 127.0.0.1; the managed listener is IPv4 only.');
      if (!['localhost', '127.0.0.1'].includes(host)) fail(`DATABASE_URL points at ${url.hostname || 'no host'}; dev-db manages only IPv4 loopback databases.`);
      const port = url.port || '5432';
      if (!/^\d+$/u.test(port) || Number(port) < 1 || Number(port) > 65535) fail('DATABASE_URL must declare a usable TCP port from 1 through 65535.');
      return {
        database: decode(url.pathname.slice(1), 'database name'),
        password: decode(url.password, 'password'),
        port,
        user: decode(url.username, 'user'),
      };
    };
    const exists = () => {
      const result = podman(['container', 'exists', name]);
      if (result.exitCode === 0) return true;
      if (result.exitCode === 1) return false;
      podmanFailed(`Unable to determine whether container ${name} exists`, result);
    };
    const inspectManaged = (expectedPort) => {
      const result = podman(['container', 'inspect', name]);
      if (result.exitCode !== 0) podmanFailed(`Unable to inspect container ${name}`, result);
      let container;
      try {
        container = JSON.parse(result.stdout.toString())[0];
      } catch (error) {
        fail(`Unable to parse Podman inspection for ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const mismatches = [];
      const bindings = container?.HostConfig?.PortBindings?.['5432/tcp'];
      const binding = Array.isArray(bindings) && bindings.length === 1 ? bindings[0] : undefined;
      if (container?.Config?.Labels?.[ownershipLabel] !== 'true') mismatches.push(`missing ${ownershipLabel}=true ownership label`);
      const currentImage = container?.ImageName ?? container?.Config?.Image;
      if (currentImage !== image) mismatches.push(`image is ${currentImage ?? 'unreadable'} rather than ${image}`);
      if (binding?.HostIp !== '127.0.0.1') mismatches.push('PostgreSQL is not bound exactly once to 127.0.0.1');
      if (!/^\d+$/u.test(binding?.HostPort ?? '') || Number(binding?.HostPort) < 1 || Number(binding?.HostPort) > 65535) mismatches.push('published PostgreSQL port is unusable');
      if (expectedPort !== undefined && binding?.HostPort !== expectedPort) mismatches.push(`published port ${binding?.HostPort || 'none'} does not match DATABASE_URL port ${expectedPort}`);
      const dataMount = Array.isArray(container?.Mounts) ? container.Mounts.find((mount) => mount?.Destination === dataDestination) : undefined;
      if (dataMount?.Type !== 'volume' || dataMount?.Name !== volume) mismatches.push(`data mount is not the ${volume} named volume`);
      const versionAdvice = currentImage === image ? '' : ` A PostgreSQL major version cannot read another major version's data directory, so changing devDatabase.postgresVersion discards the local database: podman rm -f ${name} && podman volume rm ${volume}.`;
      if (mismatches.length > 0) fail(`Container ${name} does not match the canonical dev-db shape: ${mismatches.join('; ')}. Refusing to ${action} it.${versionAdvice}`);
      return container;
    };
    if (!['start', 'stop', 'status'].includes(action)) fail(`Unsupported internal dev-db action: ${action}`);
    const connection = action === 'start' ? await readConnection() : undefined;
    const declaredPostgresVersion = action === 'start' ? readPostgresVersion() : undefined;
    const present = exists();
    if (!present && action === 'stop') { console.log(`No managed container named ${name} exists.`); process.exit(0); }
    if (!present && action === 'status') { console.log(`${name}: not created. Run \`just dev-db-start\`.`); process.exit(0); }
    const postgresVersion = declaredPostgresVersion ?? readPostgresVersion();
    const image = `docker.io/library/postgres:${postgresVersion}`;
    const parentDataLayoutVersion = 18;
    const dataDestination = Number(postgresVersion) >= parentDataLayoutVersion ? '/var/lib/postgresql' : '/var/lib/postgresql/data';
    if (action === 'start') {
      if (!present) {
        const created = podman(['run', '-d', '--name', name, '--label', `${ownershipLabel}=true`, '-e', `POSTGRES_USER=${connection.user}`, '-e', `POSTGRES_PASSWORD=${connection.password}`, '-e', `POSTGRES_DB=${connection.database}`, '-p', `127.0.0.1:${connection.port}:5432`, '-v', `${volume}:${dataDestination}`, image]);
        if (created.exitCode !== 0) podmanFailed(`Unable to create container ${name}`, created);
      }
      const container = inspectManaged(connection.port);
      if (container?.State?.Running !== true) {
        const started = podman(['start', name]);
        if (started.exitCode !== 0) podmanFailed(`Unable to start container ${name}`, started);
      }
      let lastReadinessError = '';
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const verified = podman(['exec', '--env', 'PGPASSWORD', name, 'psql', '--host', '127.0.0.1', '--port', '5432', '--username', connection.user, '--dbname', connection.database, '--no-password', '--no-psqlrc', '--tuples-only', '--no-align', '--command', 'SELECT 1'], { env: { ...process.env, PGPASSWORD: connection.password } });
        if (verified.exitCode === 0 && verified.stdout.toString().trim() === '1') {
          console.log(`${name} is running and accepts the configured DATABASE_URL on 127.0.0.1:${connection.port}.`);
          process.exit(0);
        }
        lastReadinessError = detail(verified);
        if (attempt < 29) await Bun.sleep(1000);
      }
      fail(`${name} started but the configured DATABASE_URL did not become usable${lastReadinessError ? `: ${lastReadinessError}` : ''}. Inspect with: podman logs ${name}`);
    }
    const container = inspectManaged(undefined);
    const published = container.HostConfig.PortBindings['5432/tcp'][0].HostPort;
    if (action === 'status') { console.log(`${name}: ${container?.State?.Status ?? 'unknown'} (127.0.0.1:${published})`); process.exit(0); }
    const stopped = podman(['stop', name]);
    if (stopped.exitCode !== 0) podmanFailed(`Unable to stop container ${name}`, stopped);
    console.log(`${name} stopped.`);

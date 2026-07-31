set dotenv-load := false

mod secrets 'secrets.just'

# Repo-specific recipes and modules extend this canonical file from a
# repo-owned local.just; this file is synced and must not be edited locally.

import? 'local.just'

default:
    @just --list

# Compose each workspace's .env.local from tracked config/dev.yaml, the SOPS-encrypted secrets/dev.yaml, and gitignored config/dev.local.yaml overrides
dev-env-generate:
    bun standards dev-env

# Edit dev secrets, then regenerate the derived dev env files
dev-refresh:
    just secrets edit dev
    just dev-env-generate

# Start (creating on first use) the repo's local dev PostgreSQL podman container, derived from the DATABASE_URL in packages/db/.env.local
dev-db-start:
    #!/usr/bin/env bun
    const fail = (message) => { console.error(message); process.exit(1); };
    const packageName = (await Bun.file('package.json').json().catch(() => ({}))).name ?? '';
    const repo = /^@([^/]+)\//u.exec(packageName)?.[1] ?? packageName;
    if (!repo) fail('The root package.json declares no name to derive the container name from.');
    const name = `${repo}-dev-postgres`;
    const envFile = 'packages/db/.env.local';
    if (!(await Bun.file(envFile).exists())) fail(`${envFile} not found. Run \`just dev-env-generate\` first.`);
    const probe = Bun.spawnSync(['bun', `--env-file=${envFile}`, '-e', 'process.stdout.write(process.env.DATABASE_URL ?? "")']);
    const databaseUrl = probe.stdout.toString();
    if (!databaseUrl) fail(`${envFile} declares no DATABASE_URL. dev-db manages only repos whose db package uses one.`);
    const url = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) fail(`DATABASE_URL points at ${url.hostname}; dev-db manages only local databases.`);
    const port = url.port || '5432';
    const inspected = Bun.spawnSync(['podman', 'container', 'inspect', name]);
    if (inspected.exitCode === 0) {
      const container = JSON.parse(inspected.stdout.toString())[0];
      const published = container?.HostConfig?.PortBindings?.['5432/tcp']?.[0]?.HostPort ?? '';
      if (published !== port) fail(`Container ${name} publishes port ${published || 'none'}, but DATABASE_URL expects ${port}. Remove it (podman rm -f ${name}) and rerun to recreate. Credentials rotate only with a fresh volume (podman volume rm ${name}-data).`);
      if (Bun.spawnSync(['podman', 'start', name]).exitCode !== 0) fail(`Unable to start container ${name}.`);
    } else {
      const created = Bun.spawnSync(['podman', 'run', '-d', '--name', name,
        '-e', `POSTGRES_USER=${decodeURIComponent(url.username)}`,
        '-e', `POSTGRES_PASSWORD=${decodeURIComponent(url.password)}`,
        '-e', `POSTGRES_DB=${url.pathname.replace(/^\//u, '')}`,
        '-p', `127.0.0.1:${port}:5432`,
        '-v', `${name}-data:/var/lib/postgresql/data`,
        'docker.io/library/postgres:17']);
      if (created.exitCode !== 0) fail(`podman run failed for ${name}: ${created.stderr.toString().trim()}`);
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (Bun.spawnSync(['podman', 'exec', name, 'pg_isready', '-U', decodeURIComponent(url.username)]).exitCode === 0) {
        console.log(`${name} is running and accepting connections on 127.0.0.1:${port}.`);
        process.exit(0);
      }
      await Bun.sleep(1000);
    }
    fail(`${name} started but PostgreSQL did not become ready. Inspect with: podman logs ${name}`);

# Stop the repo's local dev PostgreSQL podman container
dev-db-stop:
    #!/usr/bin/env bun
    const packageName = (await Bun.file('package.json').json().catch(() => ({}))).name ?? '';
    const name = `${/^@([^/]+)\//u.exec(packageName)?.[1] ?? packageName}-dev-postgres`;
    if (Bun.spawnSync(['podman', 'container', 'exists', name]).exitCode !== 0) { console.log(`No container named ${name} exists.`); process.exit(0); }
    if (Bun.spawnSync(['podman', 'stop', name]).exitCode !== 0) { console.error(`Unable to stop container ${name}.`); process.exit(1); }
    console.log(`${name} stopped.`);

# Show the state of the repo's local dev PostgreSQL podman container
dev-db-status:
    #!/usr/bin/env bun
    const packageName = (await Bun.file('package.json').json().catch(() => ({}))).name ?? '';
    const name = `${/^@([^/]+)\//u.exec(packageName)?.[1] ?? packageName}-dev-postgres`;
    const inspected = Bun.spawnSync(['podman', 'container', 'inspect', name]);
    if (inspected.exitCode !== 0) { console.log(`${name}: not created. Run \`just dev-db-start\`.`); process.exit(0); }
    const container = JSON.parse(inspected.stdout.toString())[0];
    const published = container?.HostConfig?.PortBindings?.['5432/tcp']?.[0]?.HostPort ?? 'unknown';
    console.log(`${name}: ${container?.State?.Status ?? 'unknown'} (port ${published})`);

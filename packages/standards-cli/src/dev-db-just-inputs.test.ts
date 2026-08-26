import { afterEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { cleanupTmpDirs, write } from './cli-test-support';
import {
  calls,
  createFixture,
  rejectedBeforePodman,
  run,
} from './dev-db-just-test-support';

const fixture = (
  packageName = '@standards/root',
  databaseUrl = 'postgres://file-user:file-pass@localhost:5440/file-db',
  postgresVersion?: string,
) => createFixture(packageName, databaseUrl, process.env, postgresVersion);

afterEach(cleanupTmpDirs);

describe('canonical dev database inputs', () => {
  it('accepts both protocols and IPv4 hosts with exact create and readiness commands', () => {
    const urls =
      'postgres://file-user:file-pass@LOCALHOST:5440/file-db|postgres://file-user:file-pass@127.0.0.1:5440/file-db|postgresql://file-user:file-pass@localhost:5440/file-db|postgresql://file-user:file-pass@127.0.0.1:5440/file-db'.split(
        '|',
      );
    for (const databaseUrl of urls) {
      const value = fixture('@acme/root', databaseUrl);
      expect(run(value, 'dev-db-start').status).toBe(0);
    }
  });

  it('rejects unsupported URLs, query overrides, fragments, and missing generated values', () => {
    const invalid =
      'http://u:p@localhost:5440/db|postgres://u:p@[::1]:5440/db|postgres://u:p@localhost:0/db|postgres://:p@localhost:5440/db|postgres://u@localhost:5440/db|postgres://u:p@localhost:5440/|postgres://%ZZ:p@localhost:5440/db|postgres://u:p@example.com:5440/db|postgres://u:p@localhost:5440/db?host=192.0.2.1|postgres://u:p@localhost:5440/db?hostaddr=192.0.2.1|postgres://u:p@localhost:5440/db?port=6543|postgres://u:p@localhost:5440/db?user=other|postgres://u:p@localhost:5440/db?sslmode=require|postgres://u:p@localhost:5440/db#fragment'.split(
        '|',
      );
    for (const databaseUrl of invalid) {
      expect(rejectedBeforePodman(fixture('acme', databaseUrl))).toBe(true);
    }
    const missingFile = fixture();
    rmSync(join(missingFile.root, 'packages/db/.env.local'));
    expect(rejectedBeforePodman(missingFile)).toBe(true);
    const missingValue = fixture();
    write(missingValue.root, 'packages/db/.env.local', 'OTHER=value\n');
    expect(rejectedBeforePodman(missingValue)).toBe(true);
    for (const manifest of '{}|{"name":2}|{"name":"bad/name"}|{broken'.split(
      '|',
    )) {
      const value = fixture();
      write(value.root, 'package.json', manifest);
      expect(rejectedBeforePodman(value)).toBe(true);
    }
  });

  it('requires a declared PostgreSQL major version', () => {
    const versions =
      '|{}|{"postgresVersion":18}|{"postgresVersion":""}|{"postgresVersion":"latest"}|{"postgresVersion":"0"}|{"postgresVersion":"17.6"}|{"postgresVersion":"18 "}|"18"'.split(
        '|',
      );
    for (const devDatabase of versions) {
      const value = fixture();
      write(
        value.root,
        'package.json',
        devDatabase === ''
          ? '{"name":"acme"}'
          : `{"name":"acme","devDatabase":${devDatabase}}`,
      );
      expect(rejectedBeforePodman(value)).toBe(true);
    }
  });

  it('runs the declared major with its official data mount layout', () => {
    for (const [version, destination] of [
      ['17', '/var/lib/postgresql/data'],
      ['18', '/var/lib/postgresql'],
    ] as const) {
      const value = fixture('@standards/root', undefined, version);
      expect(run(value, 'dev-db-start').status).toBe(0);
      expect(calls(value)).toContain(`"docker.io/library/postgres:${version}"`);
      expect(calls(value)).toContain(
        `"standards-dev-postgres-data:${destination}"`,
      );
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GITHUB_ACTIONS_ISSUER } from './release-provenance';

const FIXTURE = join(
  import.meta.dir,
  'fixtures/npm-standards-0.13.0-attestation.json',
);
const FOREIGN_FIXTURE = join(
  import.meta.dir,
  'fixtures/npm-sigstore-5.0.0-provenance.json',
);
const IDENTITY_PROBE = join(
  import.meta.dir,
  'release-provenance-identity-test-probe.ts',
);
const CERTIFICATE_IDENTITY =
  'https://github.com/davidvornholt/standards/.github/workflows/publish-standards-cli.yml@refs/heads/main';
const TEST_TIMEOUT_MS = 15_000;
let fixtureRoot = '';

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'release-provenance-identity-'));
});

afterAll(() => {
  rmSync(fixtureRoot, { force: true, recursive: true });
});

type ProbeOptions = {
  readonly fixture: string;
  readonly identity: string;
  readonly issuer: string;
  readonly tufCache: string;
  readonly tufMirrorURL?: string;
};

const runProbe = (options: ProbeOptions) =>
  spawnSync(
    'node',
    [
      IDENTITY_PROBE,
      options.fixture,
      options.issuer,
      options.identity,
      options.tufCache,
      ...(options.tufMirrorURL === undefined ? [] : [options.tufMirrorURL]),
    ],
    { encoding: 'utf8' },
  );

describe('npm provenance verification boundary', () => {
  it(
    'rejects a non-GitHub Actions certificate issuer as cryptographic',
    () => {
      const result = runProbe({
        fixture: FIXTURE,
        identity: CERTIFICATE_IDENTITY,
        issuer: 'https://issuer.example.com',
        tufCache: join(fixtureRoot, 'issuer-tuf'),
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('[cryptographic-verification-failure]');
      expect(result.stderr).toContain(
        'expected issuer=https://issuer.example.com',
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects a valid foreign GitHub Actions bundle by exact workflow identity',
    () => {
      const result = runProbe({
        fixture: FOREIGN_FIXTURE,
        identity: CERTIFICATE_IDENTITY,
        issuer: GITHUB_ACTIONS_ISSUER,
        tufCache: join(fixtureRoot, 'identity-tuf'),
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('[cryptographic-verification-failure]');
      expect(result.stderr).toContain('certificate identity');
      expect(result.stderr).not.toContain('npm provenance repository must be');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'classifies an unavailable TUF mirror as operational',
    () => {
      const result = runProbe({
        fixture: FIXTURE,
        identity: CERTIFICATE_IDENTITY,
        issuer: GITHUB_ACTIONS_ISSUER,
        tufCache: join(fixtureRoot, 'unavailable-tuf'),
        tufMirrorURL: 'http://127.0.0.1:1',
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('[operational-verification-failure]');
    },
    TEST_TIMEOUT_MS,
  );
});

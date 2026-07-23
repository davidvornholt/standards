import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE = join(
  import.meta.dir,
  'fixtures/npm-standards-0.13.0-attestation.json',
);
const RECOVERY_SCRIPT = join(import.meta.dir, '../scripts/release-recovery.ts');
const ISSUER_PROBE = join(
  import.meta.dir,
  'release-provenance-issuer-test-probe.ts',
);
const PACKAGE_NAME = '@davidvornholt/standards';
const VERSION = '0.13.0';
const REPOSITORY = 'davidvornholt/standards';
const SERVER_URL = 'https://github.com';
const WORKFLOW_REF =
  'davidvornholt/standards/.github/workflows/publish-standards-cli.yml@refs/heads/main';
const COMMIT = '1764cab73dee8a95d8e3e47b064fa8e7080f08dd';
const MISMATCHED_COMMIT = 'ffffffffffffffffffffffffffffffffffffffff';
const SHA512_HEX_LENGTH = 128;
const CRYPTO_TEST_TIMEOUT_MS = 15_000;
const INTEGRITY =
  'sha512-+VI4epdPLqRVB4G6Mly2+QZtGvfmCmWWL15/WUSNHLgRrbL1FVJQ3ZsrzFruEtakrGI96FsDp68LxYkgUKo4IQ==';

type MutableRecord = Record<string, unknown>;
type Fixture = {
  attestations: [
    {
      bundle: {
        dsseEnvelope: { payload: string };
      };
    },
  ];
};

let fixtureRoot = '';
let tufCache = '';

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'release-provenance-fixture-'));
  tufCache = join(fixtureRoot, 'tuf');
});

afterAll(() => {
  rmSync(fixtureRoot, { force: true, recursive: true });
});

const runProvenance = (fixture: string) =>
  spawnSync(
    'node',
    [
      RECOVERY_SCRIPT,
      'provenance',
      fixture,
      PACKAGE_NAME,
      VERSION,
      REPOSITORY,
      SERVER_URL,
      WORKFLOW_REF,
      COMMIT,
      INTEGRITY,
      tufCache,
    ],
    { encoding: 'utf8' },
  );

const mutatedFixture = (
  name: string,
  change: (statement: MutableRecord) => void,
): string => {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;
  const envelope = fixture.attestations[0].bundle.dsseEnvelope;
  const statement = JSON.parse(
    Buffer.from(envelope.payload, 'base64').toString('utf8'),
  ) as MutableRecord;
  change(statement);
  envelope.payload = Buffer.from(JSON.stringify(statement)).toString('base64');
  const path = join(fixtureRoot, `${name}.json`);
  writeFileSync(path, JSON.stringify(fixture));
  return path;
};

const nestedRecord = (
  value: MutableRecord,
  ...path: ReadonlyArray<string>
): MutableRecord => {
  let current = value;
  for (const key of path) {
    current = current[key] as MutableRecord;
  }
  return current;
};

describe('npm provenance cryptographic verification', () => {
  it('accepts the authentic real-format npm 0.13.0 bundle', () => {
    const result = runProvenance(FIXTURE);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it.each([
    [
      'repository',
      (value: MutableRecord) => {
        nestedRecord(
          value,
          'predicate',
          'buildDefinition',
          'externalParameters',
          'workflow',
        ).repository = 'https://github.com/example/standards';
      },
    ],
    [
      'workflow',
      (value: MutableRecord) => {
        nestedRecord(
          value,
          'predicate',
          'buildDefinition',
          'externalParameters',
          'workflow',
        ).path = '.github/workflows/other.yml';
      },
    ],
    [
      'commit',
      (value: MutableRecord) => {
        const dependencies = nestedRecord(value, 'predicate', 'buildDefinition')
          .resolvedDependencies as Array<MutableRecord>;
        nestedRecord(dependencies[0] ?? {}, 'digest').gitCommit =
          MISMATCHED_COMMIT;
      },
    ],
    [
      'subject',
      (value: MutableRecord) => {
        const subjects = value.subject as Array<MutableRecord>;
        (subjects[0] ?? {}).name = 'pkg:npm/example@0.13.0';
      },
    ],
    [
      'digest',
      (value: MutableRecord) => {
        const subjects = value.subject as Array<MutableRecord>;
        nestedRecord(subjects[0] ?? {}, 'digest').sha512 = 'f'.repeat(
          SHA512_HEX_LENGTH,
        );
      },
    ],
  ] as const)('rejects a signed %s mutation retaining the original signature', (name, change) => {
    const result = runProvenance(mutatedFixture(name, change));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('cryptographic verification failed');
  });

  it(
    'rejects a non-GitHub Actions certificate issuer',
    () => {
      const result = spawnSync(
        'node',
        [ISSUER_PROBE, FIXTURE, 'https://issuer.example.com', tufCache],
        { encoding: 'utf8' },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'expected issuer=https://issuer.example.com',
      );
    },
    CRYPTO_TEST_TIMEOUT_MS,
  );
});

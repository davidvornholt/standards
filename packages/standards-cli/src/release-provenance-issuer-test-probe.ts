import { readFileSync } from 'node:fs';
import process from 'node:process';
import { verifyBundleForIssuer } from './release-provenance.ts';
import {
  isJsonRecord,
  jsonArrayAt,
  jsonRecordAt,
} from './release-provenance-claims.ts';

const [fixturePath, issuer, tufCachePath] = process.argv.slice(2);
if (
  fixturePath === undefined ||
  issuer === undefined ||
  tufCachePath === undefined
) {
  process.stderr.write(
    'issuer probe requires fixture, issuer, and TUF cache\n',
  );
  process.exitCode = 1;
} else {
  const response: unknown = JSON.parse(
    readFileSync(fixturePath, 'utf8'),
  ) as unknown;
  const attestation = jsonArrayAt(
    isJsonRecord(response) ? response : null,
    'attestations',
  )?.[0];
  const bundle = jsonRecordAt(
    isJsonRecord(attestation) ? attestation : null,
    'bundle',
  );
  if (bundle === null) {
    process.stderr.write('fixture has no bundle\n');
    process.exitCode = 1;
  } else {
    verifyBundleForIssuer(bundle, {
      certificateIssuer: issuer,
      tufCachePath,
    }).then(
      (problem) => {
        if (problem === null) {
          process.exitCode = 0;
        } else {
          process.stderr.write(`${problem}\n`);
          process.exitCode = 1;
        }
      },
      (error: unknown) => {
        process.stderr.write(
          `${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      },
    );
  }
}

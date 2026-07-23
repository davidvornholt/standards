import { readFileSync } from 'node:fs';
import process from 'node:process';
import { verifyBundleForIdentity } from './release-provenance.ts';
import {
  isJsonRecord,
  jsonArrayAt,
  jsonRecordAt,
} from './release-provenance-claims.ts';

const [fixturePath, issuer, identity, tufCachePath, tufMirrorURL] =
  process.argv.slice(2);
if (
  fixturePath === undefined ||
  issuer === undefined ||
  identity === undefined ||
  tufCachePath === undefined
) {
  process.stderr.write(
    'identity probe requires fixture, issuer, identity, and TUF cache\n',
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
    verifyBundleForIdentity(bundle, {
      certificateIdentityURI: identity,
      certificateIssuer: issuer,
      tufCachePath,
      tufMirrorURL,
    }).then(
      (result) => {
        if (result.kind === 'verified') {
          process.exitCode = 0;
        } else {
          process.stderr.write(`[${result.kind}] ${result.message}\n`);
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

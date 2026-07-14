import type { Effect } from './release-effect';
import { flatMap, succeed } from './release-effect';
import type { ReleasePackageError } from './release-package-error';
import {
  RELEASE_MANIFEST_PATH,
  RELEASE_MARKER_PATH,
  type ReleaseTarScan,
  readReleaseManifest,
  releaseTarFailure,
  scanReleaseTar,
} from './release-package-tar-reader';
import { isReleaseSourceSha } from './release-source-sha';
import {
  createTarHeader,
  resizeTarHeader,
  TAR_BLOCK_SIZE,
  TAR_END_BLOCKS,
} from './release-tar-header';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type ReleaseTarIdentity = {
  readonly name: string;
  readonly sha: string;
  readonly version: string;
};

const rewriteManifest = (
  archive: Uint8Array,
  scan: ReleaseTarScan,
  expectedSha: string,
): Effect<Uint8Array, ReleasePackageError> =>
  readReleaseManifest(archive, scan.manifest).pipe(
    flatMap((manifest) =>
      succeed(
        encoder.encode(
          `${JSON.stringify({ ...manifest, gitHead: expectedSha }, null, 2)}\n`,
        ),
      ),
    ),
  );

const writeRewrittenTar = (
  archive: Uint8Array,
  scan: ReleaseTarScan,
  manifestContents: Uint8Array,
  expectedSha: string,
): Uint8Array => {
  const manifestBlocks = Math.ceil(manifestContents.length / TAR_BLOCK_SIZE);
  const preservedTail = archive.subarray(scan.manifest.nextOffset, scan.end);
  const markerContents = encoder.encode(`${expectedSha}\n`);
  const markerBlocks = Math.ceil(markerContents.length / TAR_BLOCK_SIZE);
  const output = new Uint8Array(
    scan.manifest.headerOffset +
      TAR_BLOCK_SIZE * (1 + manifestBlocks) +
      preservedTail.length +
      TAR_BLOCK_SIZE * (1 + markerBlocks + TAR_END_BLOCKS),
  );
  let offset = scan.manifest.headerOffset;
  output.set(archive.subarray(0, offset));
  output.set(
    resizeTarHeader(archive.subarray(offset), manifestContents.length),
    offset,
  );
  offset += TAR_BLOCK_SIZE;
  output.set(manifestContents, offset);
  offset += TAR_BLOCK_SIZE * manifestBlocks;
  output.set(preservedTail, offset);
  offset += preservedTail.length;
  output.set(
    createTarHeader(RELEASE_MARKER_PATH, markerContents.length),
    offset,
  );
  offset += TAR_BLOCK_SIZE;
  output.set(markerContents, offset);
  return output;
};

export const rewriteReleaseTar = (archive: Uint8Array, expectedSha: string) =>
  scanReleaseTar(archive).pipe(
    flatMap((scan) =>
      rewriteManifest(archive, scan, expectedSha).pipe(
        flatMap((contents) =>
          succeed(writeRewrittenTar(archive, scan, contents, expectedSha)),
        ),
      ),
    ),
  );

const readScannedIdentity = (
  archive: Uint8Array,
  scan: ReleaseTarScan,
): Effect<ReleaseTarIdentity, ReleasePackageError> => {
  const markerEntry = scan.marker;
  if (markerEntry === null) {
    return releaseTarFailure(`Package artifact has no ${RELEASE_MARKER_PATH}`);
  }
  return readReleaseManifest(archive, scan.manifest).pipe(
    flatMap((manifest) => {
      if (
        typeof manifest.gitHead !== 'string' ||
        !isReleaseSourceSha(manifest.gitHead) ||
        typeof manifest.name !== 'string' ||
        manifest.name === '' ||
        typeof manifest.version !== 'string' ||
        manifest.version === ''
      ) {
        return releaseTarFailure(
          `Package artifact ${RELEASE_MANIFEST_PATH} requires non-empty string name and version plus a full lowercase commit SHA gitHead`,
        );
      }
      const marker = decoder.decode(
        archive.subarray(
          markerEntry.contentOffset,
          markerEntry.contentOffset + markerEntry.size,
        ),
      );
      return marker === `${manifest.gitHead}\n`
        ? succeed({
            name: manifest.name,
            sha: manifest.gitHead,
            version: manifest.version,
          })
        : releaseTarFailure(
            `Package artifact ${RELEASE_MARKER_PATH} does not match ${RELEASE_MANIFEST_PATH} gitHead`,
          );
    }),
  );
};

export const readReleaseTarIdentity = (archive: Uint8Array) =>
  scanReleaseTar(archive, false).pipe(
    flatMap((scan) => readScannedIdentity(archive, scan)),
  );

export const verifyReleaseTarIdentity = (
  archive: Uint8Array,
  expectedSha: string,
) =>
  readReleaseTarIdentity(archive).pipe(
    flatMap((identity) =>
      identity.sha === expectedSha
        ? succeed(undefined)
        : releaseTarFailure(
            `Package artifact source commit ${identity.sha} does not match expected ${expectedSha}`,
          ),
    ),
  );

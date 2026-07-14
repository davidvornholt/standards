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
import {
  createTarHeader,
  resizeTarHeader,
  TAR_BLOCK_SIZE,
  TAR_END_BLOCKS,
} from './release-tar-header';

const encoder = new TextEncoder();

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

export const verifyReleaseTarGitHead = (
  archive: Uint8Array,
  expectedSha: string,
) =>
  scanReleaseTar(archive, false).pipe(
    flatMap((scan) =>
      readReleaseManifest(archive, scan.manifest).pipe(
        flatMap((manifest) =>
          manifest.gitHead === expectedSha
            ? succeed(undefined)
            : releaseTarFailure(
                `Package artifact ${RELEASE_MANIFEST_PATH} gitHead does not match expected ${expectedSha}`,
              ),
        ),
      ),
    ),
  );

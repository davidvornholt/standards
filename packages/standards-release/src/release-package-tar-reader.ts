import type { Effect } from './release-effect';
import { effectTry, fail, flatMap, gen, succeed } from './release-effect';
import { ReleasePackageError } from './release-package-error';
import {
  isZeroTarBlock,
  parseTarHeader,
  TAR_BLOCK_SIZE,
  TAR_END_BLOCKS,
} from './release-tar-header';

export const RELEASE_MARKER_PATH = 'package/SOURCE_COMMIT';
export const RELEASE_MANIFEST_PATH = 'package/package.json';
const decoder = new TextDecoder();

export type TarEntry = {
  readonly contentOffset: number;
  readonly headerOffset: number;
  readonly nextOffset: number;
  readonly size: number;
};

export type ReleaseTarScan = {
  readonly end: number;
  readonly manifest: TarEntry;
};

export const releaseTarFailure = <A = never>(
  message: string,
): Effect<A, ReleasePackageError> => fail(new ReleasePackageError({ message }));

const inspectEntry = (input: {
  readonly entry: TarEntry;
  readonly manifest: TarEntry | null;
  readonly name: string;
  readonly rejectSourceCommit: boolean;
}): Effect<TarEntry | null, ReleasePackageError> => {
  if (input.rejectSourceCommit && input.name === RELEASE_MARKER_PATH) {
    return releaseTarFailure(
      `Packing release artifact refused existing archive entry ${RELEASE_MARKER_PATH}`,
    );
  }
  if (input.name !== RELEASE_MANIFEST_PATH) {
    return succeed(input.manifest);
  }
  return input.manifest === null
    ? succeed(input.entry)
    : releaseTarFailure(
        `Packing release artifact contains duplicate ${RELEASE_MANIFEST_PATH}`,
      );
};

const completeScan = (
  bytes: Uint8Array,
  offset: number,
  manifest: TarEntry | null,
): Effect<ReleaseTarScan, ReleasePackageError> => {
  if (!isZeroTarBlock(bytes, offset + TAR_BLOCK_SIZE)) {
    return releaseTarFailure(
      'Packing release artifact produced an invalid tar payload',
    );
  }
  return manifest === null
    ? releaseTarFailure(
        `Packing release artifact has no ${RELEASE_MANIFEST_PATH}`,
      )
    : succeed({ end: offset, manifest });
};

const readEntry = (
  bytes: Uint8Array,
  offset: number,
): Effect<
  { readonly entry: TarEntry; readonly name: string },
  ReleasePackageError
> => {
  const header = parseTarHeader(bytes, offset);
  if (header === null) {
    return releaseTarFailure(
      'Packing release artifact produced an invalid tar payload',
    );
  }
  const contentOffset = offset + TAR_BLOCK_SIZE;
  const nextOffset =
    contentOffset + Math.ceil(header.size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  if (nextOffset > bytes.length) {
    return releaseTarFailure(
      'Packing release artifact produced an invalid tar payload',
    );
  }
  return succeed({
    entry: {
      contentOffset,
      headerOffset: offset,
      nextOffset,
      size: header.size,
    },
    name: header.name,
  });
};

export const scanReleaseTar = (
  bytes: Uint8Array,
  rejectSourceCommit = true,
): Effect<ReleaseTarScan, ReleasePackageError> =>
  gen(function* () {
    let offset = 0;
    let manifest: TarEntry | null = null;
    while (offset + TAR_BLOCK_SIZE * TAR_END_BLOCKS <= bytes.length) {
      if (isZeroTarBlock(bytes, offset)) {
        return yield* completeScan(bytes, offset, manifest);
      }
      const { entry, name } = yield* readEntry(bytes, offset);
      manifest = yield* inspectEntry({
        entry,
        manifest,
        name,
        rejectSourceCommit,
      });
      offset = entry.nextOffset;
    }
    return yield* releaseTarFailure(
      'Packing release artifact produced an invalid tar payload',
    );
  });

export const readReleaseManifest = (
  archive: Uint8Array,
  manifest: TarEntry,
): Effect<Readonly<Record<string, unknown>>, ReleasePackageError> =>
  effectTry({
    try: () =>
      JSON.parse(
        decoder.decode(
          archive.subarray(
            manifest.contentOffset,
            manifest.contentOffset + manifest.size,
          ),
        ),
      ) as unknown,
    catch: (cause) =>
      new ReleasePackageError({
        message: `Packing release artifact has invalid ${RELEASE_MANIFEST_PATH}: ${String(cause)}`,
      }),
  }).pipe(
    flatMap((value) =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? succeed(value as Readonly<Record<string, unknown>>)
        : releaseTarFailure(
            `Packing release artifact has non-object ${RELEASE_MANIFEST_PATH}`,
          ),
    ),
  );

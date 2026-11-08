// A file sync owns only down to a marker line: the shared head above it comes
// from the standards source, and the repository's own part below it stays.
export type SplitFile = {
  readonly rel: string;
  readonly marker: string;
  // What the repository keeps below the marker, for messages.
  readonly own: string;
  // Problems the whole file has although it splits at the marker, such as an
  // own part that changes the shared head. Sync refuses to write them.
  readonly verify?: (head: string, text: string) => ReadonlyArray<string>;
};

export type Split = { readonly head: string; readonly tail: string };

// The marker as a whole line, ending in LF, CRLF, or the end of the file. The
// markers contain no regex syntax, so they go into the pattern as they are.
const markerLines = (
  marker: string,
  text: string,
): ReadonlyArray<RegExpExecArray> => [
  ...text.matchAll(new RegExp(`(?<![^\\n])${marker}(?:\\r?\\n|$)`, 'gu')),
];

export const countMarkerLines = (marker: string, text: string): number =>
  markerLines(marker, text).length;

// Splits at the end of the first marker line, keeping the file's exact bytes.
// Null when the file has no marker line.
export const splitAt = (file: SplitFile, text: string): Split | null => {
  const [match] = markerLines(file.marker, text);
  if (match === undefined) {
    return null;
  }
  const end = match.index + match[0].length;
  return { head: text.slice(0, end), tail: text.slice(end) };
};

// The marker line always ends in a line break, even when it ends the source's
// file: otherwise it would swallow the own part's first line, and appending an
// own part would change the head that the lock records.
export const joinParts = (head: string, tail: string): string =>
  `${head.endsWith('\n') ? head : `${head}\n`}${tail}`;

// The marker as a reader types it: without its indentation, which is named.
const markerInstruction = (marker: string): string => {
  const indent = marker.length - marker.trimStart().length;
  return indent === 0
    ? 'add that line'
    : `add that line, indented ${indent} spaces,`;
};

export const missingMarker = (file: SplitFile): string =>
  `${file.rel} has no "${file.marker.trimStart()}" line; ${markerInstruction(file.marker)} at the end of the file, move ${file.own} below it (sync replaces everything above it), then re-run`;

const commentStart = (marker: string): string => `<!-- ${marker}\n`;
const COMMENT_END = '\n-->';

export const hiddenCommentMetadata = (marker: string, value: unknown): string =>
  `${commentStart(marker)}${JSON.stringify(value)}${COMMENT_END}`;

export const parseHiddenCommentMetadata = (
  body: string,
  marker: string,
): unknown | null => {
  const start = body.indexOf(commentStart(marker));
  if (start === -1) {
    return null;
  }
  const payloadStart = start + commentStart(marker).length;
  const end = body.indexOf(COMMENT_END, payloadStart);
  if (end === -1) {
    return null;
  }
  try {
    return JSON.parse(body.slice(payloadStart, end)) as unknown;
  } catch {
    return null;
  }
};

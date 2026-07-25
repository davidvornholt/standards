const CLOSING_KEYWORD_PATTERN = String.raw`(?:close(?:s|d)?|fix(?:es|ed)?|resolve(?:s|d)?):?[ \t]+#`;
const FENCE_OPEN_PATTERN = /^ {0,3}(?<marker>`{3,}|~{3,})/u;
const BODY_LINE_PATTERN = /\r?\n/u;

export const hasClosingReferenceToIssue = (
  body: string,
  issueNumber: number,
): boolean => {
  const reference = new RegExp(
    `^${CLOSING_KEYWORD_PATTERN}${issueNumber}$`,
    'iu',
  );
  let fenceClose: RegExp | null = null;
  for (const line of body.split(BODY_LINE_PATTERN)) {
    if (fenceClose === null) {
      const marker = FENCE_OPEN_PATTERN.exec(line)?.groups?.marker;
      if (marker !== undefined) {
        fenceClose = new RegExp(
          `^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`,
          'u',
        );
      } else if (reference.test(line)) {
        return true;
      }
    } else if (fenceClose.test(line)) {
      fenceClose = null;
    }
  }
  return false;
};

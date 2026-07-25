const CLOSING_KEYWORD_PATTERN = String.raw`(?:close(?:s|d)?|fix(?:es|ed)?|resolve(?:s|d)?):?[ \t]+#`;
const FENCE_OPEN_PATTERN = /^ {0,3}(?<marker>`{3,}|~{3,})(?<info>[^\r\n]*)$/u;
const BODY_LINE_PATTERN = /\r?\n/u;
const COMMENT_START = '<!--';
const COMMENT_END = '-->';

const commentIsOpenAfter = (line: string, initiallyOpen: boolean): boolean => {
  let open = initiallyOpen;
  let remaining = line;
  while (remaining.length > 0) {
    const marker = open ? COMMENT_END : COMMENT_START;
    const index = remaining.indexOf(marker);
    if (index === -1) {
      return open;
    }
    open = !open;
    remaining = remaining.slice(index + marker.length);
  }
  return open;
};

const fenceCloseForLine = (line: string): RegExp | null => {
  const groups = FENCE_OPEN_PATTERN.exec(line)?.groups;
  const marker = groups?.marker;
  if (
    marker === undefined ||
    (marker[0] === '`' && (groups?.info ?? '').includes('`'))
  ) {
    return null;
  }
  return new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`, 'u');
};

export const hasClosingReferenceToIssue = (
  body: string,
  issueNumber: number,
): boolean => {
  const reference = new RegExp(
    `^${CLOSING_KEYWORD_PATTERN}${issueNumber}$`,
    'iu',
  );
  const lines = body.split(BODY_LINE_PATTERN);
  if (!reference.test(lines.at(-1) ?? '')) {
    return false;
  }
  let fenceClose: RegExp | null = null;
  let commentOpen = false;
  for (const line of lines.slice(0, -1)) {
    if (fenceClose === null) {
      if (commentOpen) {
        commentOpen = commentIsOpenAfter(line, true);
      } else {
        fenceClose = fenceCloseForLine(line);
        if (fenceClose === null) {
          commentOpen = commentIsOpenAfter(line, false);
        }
      }
    } else if (fenceClose.test(line)) {
      fenceClose = null;
    }
  }
  return fenceClose === null && !commentOpen;
};

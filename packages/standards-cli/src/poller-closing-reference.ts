const CLOSING_KEYWORD_PATTERN = String.raw`(?:close(?:s|d)?|fix(?:es|ed)?|resolve(?:s|d)?):?[ \t]+#`;
const FENCE_OPEN_PATTERN = /^ {0,3}(?<marker>`{3,}|~{3,})(?<info>[^\r\n]*)$/u;
const BODY_LINE_PATTERN = /\r?\n/u;
const INDENTED_CODE_PATTERN = /^ {0,3}\t|^ {4}/u;
const COMMENT_START = '<!--';
const COMMENT_END = '-->';

type BacktickRun = {
  readonly start: number;
  readonly end: number;
};

const isEscaped = (line: string, index: number): boolean => {
  let backslashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && line[cursor] === '\\';
    cursor -= 1
  ) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
};

const nextBacktickRun = (line: string, from: number): BacktickRun | null => {
  let start = line.indexOf('`', from);
  while (start !== -1) {
    let end = start + 1;
    while (line[end] === '`') {
      end += 1;
    }
    if (!isEscaped(line, start)) {
      return { start, end };
    }
    start = line.indexOf('`', end);
  }
  return null;
};

const matchingBacktickRun = (
  line: string,
  opener: BacktickRun,
): BacktickRun | null => {
  const ticks = opener.end - opener.start;
  let candidate = nextBacktickRun(line, opener.end);
  while (candidate !== null) {
    if (candidate.end - candidate.start === ticks) {
      return candidate;
    }
    candidate = nextBacktickRun(line, candidate.end);
  }
  return null;
};

const nextActiveCommentStart = (line: string, from: number): number => {
  let cursor = from;
  while (cursor < line.length) {
    const comment = line.indexOf(COMMENT_START, cursor);
    const opener = nextBacktickRun(line, cursor);
    if (
      comment !== -1 &&
      !isEscaped(line, comment) &&
      (opener === null || comment < opener.start)
    ) {
      return comment;
    }
    if (opener === null) {
      return -1;
    }
    const closer = matchingBacktickRun(line, opener);
    cursor = closer === null ? opener.end : closer.end;
  }
  return -1;
};

const commentIsOpenAfter = (line: string, initiallyOpen: boolean): boolean => {
  let open = initiallyOpen;
  let cursor = 0;
  while (cursor < line.length) {
    const marker = open
      ? line.indexOf(COMMENT_END, cursor)
      : nextActiveCommentStart(line, cursor);
    if (marker === -1) {
      return open;
    }
    open = !open;
    cursor = marker + (open ? COMMENT_START.length : COMMENT_END.length);
  }
  return open;
};

const isIndentedCodeLine = (
  lines: ReadonlyArray<string>,
  index: number,
): boolean => {
  if (!INDENTED_CODE_PATTERN.test(lines[index] ?? '')) {
    return false;
  }
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const previous = lines[cursor] ?? '';
    if (previous.trim().length === 0) {
      return true;
    }
    if (!INDENTED_CODE_PATTERN.test(previous)) {
      return false;
    }
  }
  return true;
};

const commentStateAfterContentLine = (
  lines: ReadonlyArray<string>,
  index: number,
  initiallyOpen: boolean,
): boolean => {
  if (!initiallyOpen && isIndentedCodeLine(lines, index)) {
    return false;
  }
  return commentIsOpenAfter(lines[index] ?? '', initiallyOpen);
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

type MarkdownState = {
  readonly fenceClose: RegExp | null;
  readonly commentOpen: boolean;
};

const markdownStateAfterContentLine = (
  lines: ReadonlyArray<string>,
  index: number,
  state: MarkdownState,
): MarkdownState => {
  const line = lines[index] ?? '';
  if (state.fenceClose !== null) {
    return {
      fenceClose: state.fenceClose.test(line) ? null : state.fenceClose,
      commentOpen: state.commentOpen,
    };
  }
  const fenceClose = state.commentOpen ? null : fenceCloseForLine(line);
  return {
    fenceClose,
    commentOpen:
      fenceClose === null
        ? commentStateAfterContentLine(lines, index, state.commentOpen)
        : state.commentOpen,
  };
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
  let state: MarkdownState = { fenceClose: null, commentOpen: false };
  const content = lines.slice(0, -1);
  for (const [index] of content.entries()) {
    state = markdownStateAfterContentLine(content, index, state);
  }
  return state.fenceClose === null && !state.commentOpen;
};

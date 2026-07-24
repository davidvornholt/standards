const STDERR_SNIPPET_LIMIT = 2000;
const STDERR_RETAINED_LIMIT = STDERR_SNIPPET_LIMIT * 2;
const CAPTURE_FAILURE_DETAIL_LIMIT = 800;
const CAPTURE_FAILURE_PREFIX = 'stderr capture failed: ';
const STDERR_WITH_CAPTURE_FAILURE_LIMIT =
  STDERR_SNIPPET_LIMIT -
  CAPTURE_FAILURE_PREFIX.length -
  CAPTURE_FAILURE_DETAIL_LIMIT -
  '\n'.length;
const LOW_SURROGATE_MIN = 0xdc_00;
const LOW_SURROGATE_MAX = 0xdf_ff;

const unicodeSafeTail = (value: string, limit: number): string => {
  let start = Math.max(0, value.length - limit);
  const first = value.charCodeAt(start);
  if (first >= LOW_SURROGATE_MIN && first <= LOW_SURROGATE_MAX) {
    start += 1;
  }
  return value.slice(start);
};

export const createStderrCapture = () => {
  const decoder = new TextDecoder();
  let retained = '';
  let pendingWhitespace = '';
  const appendText = (text: string): void => {
    const content = text.trimEnd();
    if (content === '') {
      pendingWhitespace = unicodeSafeTail(
        pendingWhitespace + text,
        STDERR_RETAINED_LIMIT,
      );
      return;
    }
    retained = unicodeSafeTail(
      retained + pendingWhitespace + content,
      STDERR_RETAINED_LIMIT,
    );
    pendingWhitespace = unicodeSafeTail(
      text.slice(content.length),
      STDERR_RETAINED_LIMIT,
    );
  };
  return {
    append: (chunk: Buffer): void => {
      appendText(decoder.decode(chunk, { stream: true }));
    },
    finish: (): string => {
      decoder.decode();
      return unicodeSafeTail(retained.trim(), STDERR_SNIPPET_LIMIT);
    },
  };
};

export const withCaptureFailure = (
  stderr: string,
  captureFailure: string | null,
): string => {
  if (captureFailure === null) {
    return stderr;
  }
  const retained = unicodeSafeTail(stderr, STDERR_WITH_CAPTURE_FAILURE_LIMIT);
  const failure = `${CAPTURE_FAILURE_PREFIX}${unicodeSafeTail(
    captureFailure,
    CAPTURE_FAILURE_DETAIL_LIMIT,
  )}`;
  return retained === '' ? failure : `${retained}\n${failure}`;
};

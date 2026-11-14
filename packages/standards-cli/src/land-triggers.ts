// Whether one event under a workflow's `on` runs the workflow for a pull
// request, by GitHub's filters for `pull_request`, `pull_request_target` and
// `push`. A filter this can't read lets the event run, so land waits for
// checks rather than merging without them.

import { isRecord } from './github-settings-parse';

export type TriggerTarget = {
  readonly base: string;
  readonly head: string;
  // The changed paths, with the old path of each renamed file. Null when
  // GitHub doesn't list them all. Read only for a path filter.
  readonly changedFiles: () => ReadonlyArray<string> | null;
};

// Every other activity type can fire on an open pull request just before
// land merges it.
const CLOSED = 'closed';
// The characters that a pattern's literal text escapes in a RegExp.
const REGEXP_SYNTAX = /[\^$\\.*+?()[\]{}|/]/u;
// The tokens of GitHub's filter patterns, in the order they take precedence.
const PATTERN_TOKEN = /\\.|\*\*\/|\*\*|\*|\?|\+|\[(?:\\.|[^\]])*\]|./gu;

const tokenSource = (token: string): string => {
  // `**/` also matches no folder, so `**/a` matches `a`.
  if (token === '**/') {
    return '(?:.*/)?';
  }
  if (token === '**') {
    return '.*';
  }
  if (token === '*') {
    return '[^/]*';
  }
  // `?` and `+` repeat the character before them, as in a RegExp.
  if (token === '?' || token === '+' || token.startsWith('[')) {
    return token;
  }
  const literal = token.startsWith('\\') ? token.slice(1) : token;
  return REGEXP_SYNTAX.test(literal) ? `\\${literal}` : literal;
};

// Null for a pattern that isn't valid.
const patternRegExp = (pattern: string): RegExp | null => {
  try {
    const source = (pattern.match(PATTERN_TOKEN) ?? []).map(tokenSource);
    return new RegExp(`^(?:${source.join('')})$`, 'u');
  } catch {
    return null;
  }
};

// The patterns of a filter, which is a pattern or a list of them. Null for
// any other shape.
const patterns = (filter: unknown): ReadonlyArray<string> | null => {
  const list = typeof filter === 'string' ? [filter] : filter;
  return Array.isArray(list) &&
    list.length > 0 &&
    list.every((pattern) => typeof pattern === 'string')
    ? list
    : null;
};

// Whether a name passes a filter's patterns, where the last pattern that
// matches decides and a leading `!` excludes. Null for a pattern that isn't
// valid.
const lastMatchIncludes = (
  list: ReadonlyArray<string>,
  name: string,
): boolean | null =>
  list.reduce<boolean | null>((included, pattern) => {
    const excludes = pattern.startsWith('!');
    const regExp = patternRegExp(excludes ? pattern.slice(1) : pattern);
    if (included === null || regExp === null) {
      return null;
    }
    return regExp.test(name) ? !excludes : included;
  }, false);

// Whether the names pass a filter and its `-ignore` counterpart, given that
// any one passing name is enough.
const passes = (
  config: Readonly<Record<string, unknown>>,
  key: string,
  names: () => ReadonlyArray<string> | null,
): boolean => {
  const ignoreKey = `${key}-ignore`;
  const included = key in config;
  const ignored = ignoreKey in config;
  // Without either filter every name passes, and GitHub rejects a workflow
  // with both.
  if (included === ignored) {
    return true;
  }
  const list = patterns(config[included ? key : ignoreKey]);
  const all = list === null ? null : names();
  if (list === null || all === null) {
    return true;
  }
  return all.some((name) => {
    const match = lastMatchIncludes(list, name);
    return match === null || match === included;
  });
};

const pullRequestRuns = (
  config: Readonly<Record<string, unknown>>,
  target: TriggerTarget,
): boolean => {
  const types = patterns(config.types);
  return (
    (!('types' in config) ||
      types === null ||
      types.some((type) => type !== CLOSED)) &&
    passes(config, 'branches', () => [target.base])
  );
};

// A push of the head branch also reports on the pull request's head. A
// push filter that names only tags leaves branches out.
const pushRuns = (
  config: Readonly<Record<string, unknown>>,
  target: TriggerTarget,
): boolean =>
  'branches' in config || 'branches-ignore' in config
    ? passes(config, 'branches', () => [target.head])
    : !('tags' in config || 'tags-ignore' in config);

export const eventRuns = (
  event: 'pull_request' | 'pull_request_target' | 'push',
  config: unknown,
  target: TriggerTarget,
): boolean => {
  // An event without filters, such as `push:`, runs for everything, and one
  // of another shape counts as running.
  if (!isRecord(config)) {
    return true;
  }
  const refRuns =
    event === 'push'
      ? pushRuns(config, target)
      : pullRequestRuns(config, target);
  return refRuns && passes(config, 'paths', target.changedFiles);
};

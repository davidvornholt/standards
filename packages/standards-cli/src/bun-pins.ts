// Raises every Bun pin in a repository to one target version: the
// `packageManager` and `engines.bun` of its package manifests, `BUN_VERSION`
// and `bun-version` in container files and YAML, `oven/bun` image tags with
// their digests, `.bun-version`, and `.tool-versions`. It never lowers a pin,
// so a repository that moved ahead of the standards keeps its newer Bun.

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { compareVersions, VERSION } from './bun-version';
import { isContainedPath } from './contained-path';

const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const GIT_OUTPUT_LIMIT = 16_777_216;

// An image reference names a registry only in a first component with a dot, a
// port, or `localhost`, as Docker reads it; `example/oven/bun` is no image of
// `oven/bun`. Docker Hub serves `oven/bun`, and mirror.gcr.io mirrors Docker Hub with the
// same digests. A digest-pinned image from any other registry keeps its pin,
// because nothing here can resolve that registry's digest.
const DOCKER_HUB_REGISTRIES = new Set([
  '',
  'docker.io',
  'index.docker.io',
  'registry-1.docker.io',
  'mirror.gcr.io',
]);

type Pattern = {
  readonly regex: RegExp;
  readonly image: boolean;
};

const pattern = (source: string, image = false): Pattern => ({
  regex: new RegExp(source, 'gmu'),
  image,
});

const ASSIGNMENT = pattern(
  String.raw`(?<prefix>(?<![\w-])(?:BUN_VERSION|bun-version)\s*[:=]\s*(?<quote>["']?))(?<version>${VERSION})(?=\k<quote>(?![\w.-]))`,
);
const IMAGE = pattern(
  String.raw`(?<prefix>(?<![\w./-])(?:(?<registry>(?:[\w-]+(?:\.[\w-]+)+|localhost)(?::\d+)?)/)?oven/bun:)(?<version>${VERSION})(?<variant>-[\w.-]+)?(?<digest>@sha256:[0-9a-f]{64})?(?![\w.-])`,
  true,
);
const PACKAGE_MANAGER_FIELD = pattern(
  String.raw`(?<prefix>"packageManager"\s*:\s*"bun@)(?<version>${VERSION})(?=")`,
);
// `engines.bun` when it is an exact version or a `>=` floor, so a range keeps
// its meaning and a dependency named `bun` keeps its version.
const ENGINES_FIELD = pattern(
  String.raw`(?<prefix>"engines"\s*:\s*\{[^{}]*?"bun"\s*:\s*"(?:>=)?)(?<version>${VERSION})(?=")`,
);
const BUN_VERSION_FILE = pattern(
  String.raw`(?<prefix>^\s*)(?<version>${VERSION})(?=\s*$)`,
);
const TOOL_VERSIONS = pattern(
  String.raw`(?<prefix>^bun[ \t]+)(?<version>${VERSION})(?=\s|$)`,
);

const CONTAINER_FILE =
  /^(?:Dockerfile|Containerfile)(?:[.-].*)?$|\.(?:dockerfile|containerfile)$/iu;
const YAML_FILE = /\.ya?ml$/iu;

const patternsFor = (path: string): ReadonlyArray<Pattern> => {
  const name = basename(path);
  if (name === 'package.json') {
    return [PACKAGE_MANAGER_FIELD, ENGINES_FIELD];
  }
  if (name === '.bun-version') {
    return [BUN_VERSION_FILE];
  }
  if (name === '.tool-versions') {
    return [TOOL_VERSIONS];
  }
  if (CONTAINER_FILE.test(name) || YAML_FILE.test(name)) {
    return [ASSIGNMENT, IMAGE];
  }
  return [];
};

// Resolves the digest of `oven/bun:<tag>` on Docker Hub.
export type ImageDigestResolver = (tag: string) => Promise<string>;

type Match = {
  readonly index: number;
  readonly length: number;
  readonly prefix: string;
  readonly version: string;
  readonly image: {
    readonly registry: string;
    readonly variant: string;
    readonly digest: boolean;
  } | null;
};

const matchesIn = (
  text: string,
  patterns: ReadonlyArray<Pattern>,
): ReadonlyArray<Match> =>
  patterns
    .flatMap(({ regex, image }) =>
      [...text.matchAll(regex)].map((found): Match => {
        const groups = found.groups ?? {};
        return {
          index: found.index,
          length: (groups.prefix ?? '').length + (groups.version ?? '').length,
          prefix: groups.prefix ?? '',
          version: groups.version ?? '',
          image: image
            ? {
                registry: groups.registry ?? '',
                variant: groups.variant ?? '',
                digest: groups.digest !== undefined,
              }
            : null,
        };
      }),
    )
    .sort((left, right) => left.index - right.index);

export type BunPinRaise = {
  readonly path: string;
  readonly from: ReadonlyArray<string>;
};

export type BunPinPlan = {
  readonly raised: ReadonlyArray<BunPinRaise>;
  // Images that stay below the target, as `path: reference (why)`: a
  // digest-pinned image outside Docker Hub, or a tag Docker Hub didn't serve.
  readonly kept: ReadonlyArray<string>;
  // The Docker Hub tags that failed to resolve, so a caller that needs every
  // pin raised can refuse the plan.
  readonly unresolved: ReadonlyArray<string>;
  // The new content of each raised file, empty without a digest resolver.
  readonly writes: ReadonlyMap<string, string>;
};

type PlannedFile = {
  readonly path: string;
  readonly text: string;
  readonly matches: ReadonlyArray<Match>;
};

const DIGEST_SUFFIX = /^@sha256:[0-9a-f]{64}/u;

const rewrite = (
  file: PlannedFile,
  target: string,
  digests: ReadonlyMap<string, string>,
): string => {
  let result = '';
  let cursor = 0;
  for (const match of file.matches) {
    result += file.text.slice(cursor, match.index);
    result += `${match.prefix}${target}`;
    cursor = match.index + match.length;
    if (match.image !== null) {
      const tag = `${target}${match.image.variant}`;
      result += match.image.variant;
      cursor += match.image.variant.length;
      if (match.image.digest) {
        const digest = digests.get(tag);
        if (digest === undefined) {
          throw new Error(`No digest resolved for oven/bun:${tag}`);
        }
        result += `@${digest}`;
        cursor += (DIGEST_SUFFIX.exec(file.text.slice(cursor))?.[0] ?? '')
          .length;
      }
    }
  }
  return result + file.text.slice(cursor);
};

const dockerHubTag = (match: Match, target: string): string | null =>
  match.image !== null && DOCKER_HUB_REGISTRIES.has(match.image.registry)
    ? `${target}${match.image.variant}`
    : null;

const keptReason = (
  match: Match,
  target: string,
  failures: ReadonlyMap<string, string>,
): string | null => {
  if (match.image?.digest === true && dockerHubTag(match, target) === null) {
    return 'outside Docker Hub, so its digest has no resolver';
  }
  const tag = dockerHubTag(match, target);
  const failure = tag === null ? undefined : failures.get(tag);
  return failure === undefined
    ? null
    : `Docker Hub didn't resolve oven/bun:${tag}: ${failure}`;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Every digest a raise needs, plus every Docker Hub tag it moves to, so that a
// tag Docker Hub doesn't serve stays as it is instead of failing an image build.
const resolveTags = async (
  files: ReadonlyArray<PlannedFile>,
  target: string,
  resolveDigest: ImageDigestResolver,
): Promise<{
  readonly digests: ReadonlyMap<string, string>;
  readonly failures: ReadonlyMap<string, string>;
}> => {
  const tags = [
    ...new Set(
      files.flatMap(({ matches }) =>
        matches.flatMap((match) => dockerHubTag(match, target) ?? []),
      ),
    ),
  ];
  const settled = await Promise.allSettled(
    tags.map(async (tag) => {
      const digest = await resolveDigest(tag);
      if (!IMAGE_DIGEST.test(digest)) {
        throw new Error('the registry returned an invalid digest');
      }
      return digest;
    }),
  );
  const digests = new Map<string, string>();
  const failures = new Map<string, string>();
  for (const [index, outcome] of settled.entries()) {
    const tag = tags[index] ?? '';
    if (outcome.status === 'fulfilled') {
      digests.set(tag, outcome.value);
    } else {
      failures.set(tag, errorMessage(outcome.reason));
    }
  }
  return { digests, failures };
};

const trackedFiles = (dir: string): ReadonlyArray<string> | null => {
  try {
    return execFileSync('git', ['ls-files', '--cached', '-z'], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: GIT_OUTPUT_LIMIT,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\0')
      .filter((path) => path.length > 0);
  } catch {
    return null;
  }
};

// A file that can hold a pin and is a regular file inside `dir`, so a tracked
// symlink can't steer a write to its target.
const candidate = (
  dir: string,
  path: string,
  exclude: ReadonlySet<string>,
  contents: ReadonlyMap<string, string>,
): boolean =>
  !exclude.has(path) &&
  patternsFor(path).length > 0 &&
  (contents.has(path) || isContainedPath(dir, path, 'file'));

const planFile = async (
  dir: string,
  path: string,
  target: string,
  contents: ReadonlyMap<string, string>,
): Promise<PlannedFile | null> => {
  const text =
    contents.get(path) ??
    (await readFile(join(dir, path), 'utf8').catch(() => null));
  if (text === null) {
    return null;
  }
  const matches = matchesIn(text, patternsFor(path)).filter(
    ({ version }) => compareVersions(version, target) < 0,
  );
  return matches.length === 0 ? null : { path, text, matches };
};

const versionsOf = (matches: ReadonlyArray<Match>): ReadonlyArray<string> =>
  [...new Set(matches.map(({ version }) => version))].sort(compareVersions);

// Plans raising the pins in the files git tracks in `dir`, except `exclude`,
// which holds the files sync manages. `contents` stands in for files the caller
// already edited in memory. Without `resolveDigest` it only reports the raise.
// An image it can't raise stays as it is, in `kept`, while every other pin is
// raised. Returns null when `dir` isn't a git checkout.
export const planBunPins = async ({
  dir,
  target,
  exclude,
  resolveDigest,
  contents = new Map(),
}: {
  readonly dir: string;
  readonly target: string;
  readonly exclude: ReadonlySet<string>;
  readonly resolveDigest: ImageDigestResolver | null;
  readonly contents?: ReadonlyMap<string, string>;
}): Promise<BunPinPlan | null> => {
  const tracked = trackedFiles(dir);
  if (tracked === null) {
    return null;
  }
  const lower = (
    await Promise.all(
      tracked
        .filter((path) => candidate(dir, path, exclude, contents))
        .map((path) => planFile(dir, path, target, contents)),
    )
  ).filter((file) => file !== null);
  const { digests, failures } =
    resolveDigest === null
      ? { digests: new Map<string, string>(), failures: new Map() }
      : await resolveTags(lower, target, resolveDigest);
  const kept = lower.flatMap(({ path, text, matches }) =>
    matches.flatMap((match) => {
      const why = keptReason(match, target, failures);
      return why === null
        ? []
        : [
            `${path}: ${text.slice(match.index, match.index + match.length)}${match.image?.variant ?? ''} (${why})`,
          ];
    }),
  );
  const changed = lower
    .map((file) => ({
      ...file,
      matches: file.matches.filter(
        (match) => keptReason(match, target, failures) === null,
      ),
    }))
    .filter(({ matches }) => matches.length > 0);
  return {
    raised: changed.map(({ path, matches }) => ({
      path,
      from: versionsOf(matches),
    })),
    kept,
    unresolved: [...failures.keys()],
    writes: new Map(
      resolveDigest === null
        ? []
        : changed.map((file) => [file.path, rewrite(file, target, digests)]),
    ),
  };
};

export const writeFiles = async (
  dir: string,
  writes: ReadonlyMap<string, string>,
): Promise<void> => {
  await Promise.all(
    [...writes].map(([path, text]) => writeFile(join(dir, path), text)),
  );
};

// Plans the raise and writes it, unless there's no digest resolver.
export const raiseBunPins = async (
  options: Parameters<typeof planBunPins>[0],
): Promise<BunPinPlan | null> => {
  const plan = await planBunPins(options);
  if (plan !== null) {
    await writeFiles(options.dir, plan.writes);
  }
  return plan;
};

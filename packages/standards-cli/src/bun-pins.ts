// Raises every Bun pin in a repository to one target version: the
// `packageManager` and `engines.bun` of its package manifests, `BUN_VERSION`
// and `bun-version` in container files and YAML, `oven/bun` image tags with
// their digests, `.bun-version`, and `.tool-versions`. It never lowers a pin,
// so a repository that moved ahead of the standards keeps its newer Bun.

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isRecord } from './github-settings-parse';

const VERSION = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)`;
const STABLE_VERSION = new RegExp(`^${VERSION}$`, 'u');
const PACKAGE_MANAGER = new RegExp(`^bun@(?<version>${VERSION})$`, 'u');
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

// The patterns that apply to one file.
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

export const compareVersions = (left: string, right: string): number => {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < a.length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

export const isStableVersion = (version: string): boolean =>
  STABLE_VERSION.test(version);

// The version a manifest's `packageManager` pins, or null when it doesn't pin
// an exact Bun release.
export const packageManagerBunVersion = (manifest: unknown): string | null => {
  const value = isRecord(manifest) ? manifest.packageManager : undefined;
  return typeof value === 'string'
    ? (PACKAGE_MANAGER.exec(value)?.groups?.version ?? null)
    : null;
};

export const readBunVersion = async (path: string): Promise<string | null> => {
  const text = await readFile(path, 'utf8').catch(() => null);
  if (text === null) {
    return null;
  }
  try {
    return packageManagerBunVersion(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
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

export type BunPinResult = {
  readonly raised: ReadonlyArray<BunPinRaise>;
  // Digest-pinned images outside Docker Hub, as `path: reference`.
  readonly kept: ReadonlyArray<string>;
};

type PlannedFile = {
  readonly path: string;
  readonly text: string;
  readonly matches: ReadonlyArray<Match>;
  readonly kept: ReadonlyArray<string>;
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

const unresolvable = (match: Match): boolean =>
  match.image?.digest === true &&
  !DOCKER_HUB_REGISTRIES.has(match.image.registry);

// Every digest a raise needs, plus every Docker Hub tag it moves to, so that a
// tag Docker Hub doesn't serve fails here instead of in an image build.
const resolveTags = async (
  files: ReadonlyArray<PlannedFile>,
  target: string,
  resolveDigest: ImageDigestResolver,
): Promise<ReadonlyMap<string, string>> => {
  const tags = new Set(
    files.flatMap(({ matches }) =>
      matches.flatMap(({ image }) =>
        image !== null && DOCKER_HUB_REGISTRIES.has(image.registry)
          ? [`${target}${image.variant}`]
          : [],
      ),
    ),
  );
  const resolved = await Promise.all(
    [...tags].map(async (tag) => {
      const digest = await resolveDigest(tag);
      if (!IMAGE_DIGEST.test(digest)) {
        throw new Error(
          `Docker Hub returned an invalid digest for oven/bun:${tag}`,
        );
      }
      return [tag, digest] as const;
    }),
  );
  return new Map(resolved);
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

const planFile = async (
  dir: string,
  path: string,
  target: string,
): Promise<PlannedFile | null> => {
  const text = await readFile(join(dir, path), 'utf8').catch(() => null);
  if (text === null) {
    return null;
  }
  const lower = matchesIn(text, patternsFor(path)).filter(
    ({ version }) => compareVersions(version, target) < 0,
  );
  const kept = lower
    .filter(unresolvable)
    .map(
      (match) =>
        `${path}: ${text.slice(match.index, match.index + match.length)}${match.image?.variant ?? ''}`,
    );
  const matches = lower.filter((match) => !unresolvable(match));
  return lower.length === 0 ? null : { path, text, matches, kept };
};

// Raises the pins in the files git tracks in `dir`, except `exclude`, which holds
// the files sync manages. Without `resolveDigest` it only plans: it reports the
// raise and writes nothing. Returns null when `dir` isn't a git checkout.
export const raiseBunPins = async ({
  dir,
  target,
  exclude,
  resolveDigest,
}: {
  readonly dir: string;
  readonly target: string;
  readonly exclude: ReadonlySet<string>;
  readonly resolveDigest: ImageDigestResolver | null;
}): Promise<BunPinResult | null> => {
  const tracked = trackedFiles(dir);
  if (tracked === null) {
    return null;
  }
  const planned = (
    await Promise.all(
      tracked
        .filter((file) => !exclude.has(file))
        .map((file) => planFile(dir, file, target)),
    )
  ).filter((file) => file !== null);
  const changed = planned.filter(({ matches }) => matches.length > 0);
  const result: BunPinResult = {
    raised: changed.map(({ path, matches }) => ({
      path,
      from: [...new Set(matches.map(({ version }) => version))].sort(
        compareVersions,
      ),
    })),
    kept: planned.flatMap(({ kept }) => kept),
  };
  if (resolveDigest !== null) {
    const digests = await resolveTags(changed, target, resolveDigest);
    await Promise.all(
      changed.map((file) =>
        writeFile(join(dir, file.path), rewrite(file, target, digests)),
      ),
    );
  }
  return result;
};

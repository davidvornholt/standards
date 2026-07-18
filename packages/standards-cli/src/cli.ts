#!/usr/bin/env bun

// Standards CLI. Mirrors upstream-owned ("bucket 1") files from the
// davidvornholt/standards template into a consumer repo and detects local
// tampering with them. See the standards repository README for the design.
//
// This bootstrap executable keeps its runtime surface minimal and does not use
// Effect: `bunx` must be able to execute the published package before a
// consumer has dependencies. Its strict YAML parser is a declared runtime
// dependency. This is the documented exception to the repo's Effect standard
// for standalone bootstrap tooling.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path';
import process from 'node:process';
import {
  composeDependabot,
  DEPENDABOT_BASE_FILE,
  DEPENDABOT_FILE,
  DEPENDABOT_LOCAL_FILE,
} from './dependabot-compose';
import { inspectDependabot } from './dependabot-inspect';
import { CANONICAL_SETTINGS_FILE, LOCAL_SETTINGS_FILE } from './github-api';
import { runGithubApply, runGithubCheck } from './github-commands';
import { loadGithubSettings } from './github-settings';
import { isNonEmptyString, isRecord } from './github-settings-parse';
import { collectStructureProblems } from './structure-check';
import type { StructureProfile } from './structure-profile';
import { hasSafeCommand } from './structure-script';

const DEFAULT_UPSTREAM = 'github:davidvornholt/standards';

// Characters of a sha256 hex digest shown in drift reports; enough to identify.
const HASH_PREVIEW_LENGTH = 12;

const GITHUB_PREFIX = 'github:';

// Never mirrored, even under a managed directory path: build output, VCS
// metadata, and installed dependencies would otherwise pollute the lock when
// syncing from a working tree that has them.
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.turbo',
  'dist',
  '.next',
]);

type Manifest = {
  readonly upstream: string;
  readonly seedDir: string;
  readonly paths: ReadonlyArray<string>;
};

type Lock = {
  readonly upstream: string;
  readonly sha: string;
  readonly files: Record<string, string>;
};

type Source = {
  readonly dir: string;
  readonly sha: string;
  readonly cleanup: () => void;
};

type Command =
  | 'check'
  | 'dependabot'
  | 'doctor'
  | 'github'
  | 'help'
  | 'init'
  | 'structure'
  | 'sync';

type CliOptions = {
  readonly command: Command | undefined;
  readonly consumer: string;
  readonly dryRun: boolean;
  readonly from: string | undefined;
  readonly ref: string | undefined;
  readonly apply: boolean;
  readonly write: boolean;
  readonly profile: StructureProfile;
};

const sha256 = (buf: Buffer): string =>
  createHash('sha256').update(buf).digest('hex');

const toPosix = (p: string): string => p.split(sep).join('/');

const assertSafeRelativePath = (path: string, label: string): void => {
  // POSIX semantics on every platform: managed paths are repository-relative
  // POSIX paths, and win32 normalize would rewrite `/` to `\` and reject them.
  const normalized = posix.normalize(path);
  if (
    path.length === 0 ||
    path === '.' ||
    isAbsolute(path) ||
    path.includes('\\') ||
    normalized !== path ||
    path.split('/').includes('..')
  ) {
    throw new Error(
      `${label} must be a normalized repository-relative path: ${path}`,
    );
  }
};

const parseManifest = (raw: unknown): Manifest => {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('sync-standards.json must be a JSON object');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.upstream !== 'string' || typeof o.seedDir !== 'string') {
    throw new Error(
      'sync-standards.json requires string "upstream" and "seedDir"',
    );
  }
  if (
    !(Array.isArray(o.paths) && o.paths.every((p) => typeof p === 'string'))
  ) {
    throw new Error('sync-standards.json requires a string array "paths"');
  }
  assertSafeRelativePath(o.seedDir, 'sync-standards.json "seedDir"');
  for (const path of o.paths as ReadonlyArray<string>) {
    assertSafeRelativePath(path, 'sync-standards.json managed path');
  }
  if (new Set(o.paths).size !== o.paths.length) {
    throw new Error('sync-standards.json managed paths must be unique');
  }
  return {
    upstream: o.upstream,
    seedDir: o.seedDir,
    paths: o.paths as ReadonlyArray<string>,
  };
};

const loadManifest = async (path: string): Promise<Manifest> => {
  if (!existsSync(path)) {
    throw new Error(`Manifest not found: ${path}`);
  }
  return parseManifest(JSON.parse(await readFile(path, 'utf8')) as unknown);
};

const readLock = async (dir: string): Promise<Lock | null> => {
  const path = join(dir, 'sync-standards.lock');
  if (!existsSync(path)) {
    return null;
  }
  const raw = JSON.parse(await readFile(path, 'utf8')) as Lock;
  return raw;
};

const writeLock = async (dir: string, lock: Lock): Promise<void> => {
  const files = Object.fromEntries(
    Object.entries(lock.files).sort(([a], [b]) => a.localeCompare(b)),
  );
  const ordered = { upstream: lock.upstream, sha: lock.sha, files };
  await writeFile(
    join(dir, 'sync-standards.lock'),
    `${JSON.stringify(ordered, null, 2)}\n`,
  );
};

// Fetch the template into a working directory. Accepts a local path (used to
// prove the engine before the public repo exists and in tests), a github:
// shorthand, or any git URL. Remote sources default to `main`; `ref` pins a
// tag, branch, or full commit sha instead (`git fetch` accepts all three).
const resolveSource = (src: string, ref: string | undefined): Source => {
  if (existsSync(src)) {
    if (ref !== undefined) {
      throw new Error(
        `--ref requires a git URL source; a local path is used as-is: ${src}`,
      );
    }
    let sha = 'local';
    try {
      sha = execFileSync('git', ['-C', src, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      // Not a git checkout; a content-independent marker is fine for local use.
    }
    return { dir: resolve(src), sha, cleanup: () => undefined };
  }
  const url = src.startsWith(GITHUB_PREFIX)
    ? `https://github.com/${src.slice(GITHUB_PREFIX.length)}.git`
    : src;
  const target = ref ?? 'main';
  const dir = mkdtempSync(join(tmpdir(), 'standards-'));
  const cleanup = (): void => rmSync(dir, { recursive: true, force: true });
  try {
    // init + fetch instead of `clone --branch` so a full commit sha works as a
    // ref, not only tags and branches (GitHub serves reachable sha fetches).
    execFileSync('git', ['init', '--quiet', dir], { stdio: 'ignore' });
    execFileSync(
      'git',
      ['-C', dir, 'fetch', '--quiet', '--depth', '1', '--', url, target],
      { stdio: 'ignore' },
    );
    execFileSync(
      'git',
      ['-C', dir, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'],
      { stdio: 'ignore' },
    );
  } catch (error) {
    cleanup();
    throw new Error(
      `Cannot fetch "${target}" from ${url}; expected a tag, branch, or full commit sha reachable on the remote`,
      { cause: error },
    );
  }
  const sha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  return { dir, sha, cleanup };
};

// Recursively collect files under `abs`, keyed by their POSIX path relative to
// `base`. Missing paths are skipped so a manifest entry with no files is inert.
const walk = async (
  abs: string,
  base: string,
  out: Map<string, string>,
): Promise<void> => {
  const info = await stat(abs).catch(() => null);
  if (info === null) {
    return;
  }
  if (info.isDirectory()) {
    const entries = await readdir(abs);
    await Promise.all(
      entries
        .filter((entry) => !IGNORED_DIRS.has(entry))
        .map((entry) => walk(join(abs, entry), base, out)),
    );
    return;
  }
  out.set(toPosix(relative(base, abs)), abs);
};

const listManaged = async (
  dir: string,
  paths: ReadonlyArray<string>,
): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  await Promise.all(paths.map((p) => walk(join(dir, p), dir, out)));
  return out;
};

const isUnder = (a: string, b: string): boolean =>
  a === b || a.startsWith(`${b}/`);

// Managed (bucket 1) paths and seed (bucket 2) targets must never overlap, or a
// file would have two owners and `sync` could clobber a repo-owned seed.
const assertDisjoint = (
  managed: ReadonlyArray<string>,
  seeds: ReadonlyArray<string>,
): void => {
  for (const m of managed) {
    for (const s of seeds) {
      if (isUnder(m, s) || isUnder(s, m)) {
        throw new Error(
          `Managed path "${m}" overlaps seed path "${s}"; ownership is ambiguous`,
        );
      }
    }
  }
};

type MirrorResult = {
  readonly files: Record<string, string>;
  readonly created: ReadonlyArray<string>;
  readonly updated: ReadonlyArray<string>;
  readonly deleted: ReadonlyArray<string>;
  readonly tampered: ReadonlyArray<string>;
};

type MirrorOptions = {
  readonly manifest: Manifest;
  readonly srcDir: string;
  readonly consumer: string;
  readonly previous: Record<string, string>;
  readonly dryRun: boolean;
};

// Mirror managed files into the consumer, deleting any previously-locked file
// that no longer exists upstream (three-way reconcile against the lock). When
// `dryRun` is set nothing is written or deleted; the returned plan is reported.
const mirror = async ({
  manifest,
  srcDir,
  consumer,
  previous,
  dryRun,
}: MirrorOptions): Promise<MirrorResult> => {
  for (const rel of Object.keys(previous)) {
    assertSafeRelativePath(rel, 'sync-standards.lock file');
  }
  const upstream = await listManaged(srcDir, manifest.paths);
  const next: Record<string, string> = {};
  const created: Array<string> = [];
  const updated: Array<string> = [];
  const tampered: Array<string> = [];
  await Promise.all(
    [...upstream].map(async ([rel, abs]) => {
      const dest = join(consumer, rel);
      const buf = await readFile(abs);
      const hash = sha256(buf);
      const currentHash = existsSync(dest)
        ? sha256(await readFile(dest))
        : null;
      const prev = previous[rel];
      if (prev !== undefined && currentHash !== null && currentHash !== prev) {
        tampered.push(rel);
      }
      if (currentHash === null) {
        created.push(rel);
      } else if (currentHash !== hash) {
        updated.push(rel);
      }
      if (!dryRun) {
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, buf);
      }
      next[rel] = hash;
    }),
  );
  const deleted = Object.keys(previous).filter(
    (rel) => !(rel in next) && existsSync(join(consumer, rel)),
  );
  if (!dryRun) {
    await Promise.all(deleted.map((rel) => rm(join(consumer, rel))));
  }
  return { files: next, created, updated, deleted, tampered };
};

// Print what a mirror did (or, for a dry run, would do). Real syncs stay quiet
// about unchanged files and only announce deletions and clobbered local edits.
const reportMirror = (result: MirrorResult, dryRun: boolean): void => {
  if (dryRun) {
    for (const rel of result.created) {
      console.log(`  would create ${rel}`);
    }
    for (const rel of result.updated) {
      console.log(`  would update ${rel}`);
    }
    for (const rel of result.deleted) {
      console.log(`  would delete ${rel} (removed upstream)`);
    }
    if (result.tampered.length > 0) {
      console.log(
        `  would overwrite ${result.tampered.length} locally-modified canonical file(s): ${result.tampered.join(', ')}`,
      );
    }
    const changes =
      result.created.length + result.updated.length + result.deleted.length;
    console.log(
      changes === 0
        ? 'dry run: already in sync; no changes'
        : `dry run: ${result.created.length} to create, ${result.updated.length} to update, ${result.deleted.length} to delete`,
    );
    return;
  }
  for (const rel of result.deleted) {
    console.log(`  deleted ${rel} (removed upstream)`);
  }
  if (result.tampered.length > 0) {
    console.log(
      `  overwrote ${result.tampered.length} locally-modified canonical file(s): ${result.tampered.join(', ')}`,
    );
  }
};

const seedTargets = async (
  srcDir: string,
  seedDir: string,
): Promise<Map<string, string>> => {
  const root = join(srcDir, seedDir);
  const out = new Map<string, string>();
  await walk(root, root, out);
  return out;
};

const runInit = async (
  manifest: Manifest,
  src: Source,
  consumer: string,
): Promise<void> => {
  const seeds = await seedTargets(src.dir, manifest.seedDir);
  assertDisjoint(manifest.paths, [...seeds.keys()]);
  const prospectiveDependabot = await prepareProspectiveDependabot(
    manifest,
    src.dir,
    consumer,
    seeds.get(DEPENDABOT_LOCAL_FILE) ?? null,
  );
  await Promise.all(
    [...seeds].map(async ([rel, abs]) => {
      const dest = join(consumer, rel);
      if (existsSync(dest)) {
        console.log(`  kept ${rel} (already present)`);
        return;
      }
      await mkdir(dirname(dest), { recursive: true });
      await cp(abs, dest);
      console.log(`  seeded ${rel}`);
    }),
  );
  const result = await mirror({
    manifest,
    srcDir: src.dir,
    consumer,
    previous: {},
    dryRun: false,
  });
  reportMirror(result, false);
  await applyProspectiveDependabot(consumer, prospectiveDependabot, false);
  await writeLock(consumer, {
    upstream: manifest.upstream,
    sha: src.sha,
    files: result.files,
  });
  console.log(
    `init complete: ${Object.keys(result.files).length} managed file(s) at ${src.sha}`,
  );
};

const runSync = async (
  manifest: Manifest,
  src: Source,
  consumer: string,
  dryRun: boolean,
): Promise<void> => {
  const seeds = await seedTargets(src.dir, manifest.seedDir);
  assertDisjoint(manifest.paths, [...seeds.keys()]);
  const prospectiveDependabot = await prepareProspectiveDependabot(
    manifest,
    src.dir,
    consumer,
    null,
  );
  const lock = await readLock(consumer);
  const result = await mirror({
    manifest,
    srcDir: src.dir,
    consumer,
    previous: lock?.files ?? {},
    dryRun,
  });
  reportMirror(result, dryRun);
  await applyProspectiveDependabot(consumer, prospectiveDependabot, dryRun);
  if (dryRun) {
    return;
  }
  await writeLock(consumer, {
    upstream: manifest.upstream,
    sha: src.sha,
    files: result.files,
  });
  console.log(
    `sync complete: ${Object.keys(result.files).length} managed file(s) at ${src.sha}`,
  );
};

// Offline drift detection: every locked file must still match its hash. Catches
// local edits or deletions of canonical files. Does NOT detect upstream moving
// on — see the "known limitation" in the standards repository README.
const runCheck = async (consumer: string): Promise<boolean> => {
  const lock = await readLock(consumer);
  if (lock === null || Object.keys(lock.files).length === 0) {
    console.error(
      'standards: no non-empty sync-standards.lock found; run `standards init` before checking',
    );
    return false;
  }
  for (const rel of Object.keys(lock.files)) {
    assertSafeRelativePath(rel, 'sync-standards.lock file');
  }
  const results = await Promise.all(
    Object.entries(lock.files).map(async ([rel, hash]) => {
      const dest = join(consumer, rel);
      if (!existsSync(dest)) {
        return `  missing:  ${rel}`;
      }
      const current = sha256(await readFile(dest));
      if (current !== hash) {
        return `  modified: ${rel} (expected ${hash.slice(0, HASH_PREVIEW_LENGTH)}, found ${current.slice(0, HASH_PREVIEW_LENGTH)})`;
      }
      return null;
    }),
  );
  const problems = results.filter((p): p is string => p !== null);
  if (problems.length > 0) {
    console.error(
      `standards: ${problems.length} canonical file(s) drifted from the last synced state:`,
    );
    console.error(problems.join('\n'));
    console.error(
      'These files are read-only. Restore them with `bun standards sync`, or move your change upstream.',
    );
    return false;
  }
  console.log(
    `standards: ${Object.keys(lock.files).length} canonical file(s) match the last synced state`,
  );
  return true;
};

const readTextIfPresent = async (path: string): Promise<string | null> =>
  existsSync(path) ? readFile(path, 'utf8') : null;

type DependabotSources = {
  readonly base: string | null;
  readonly local: string | null;
  readonly current: string | null;
};

const readDependabotSources = async (
  consumer: string,
): Promise<DependabotSources> => ({
  base: await readTextIfPresent(join(consumer, DEPENDABOT_BASE_FILE)),
  local: await readTextIfPresent(join(consumer, DEPENDABOT_LOCAL_FILE)),
  current: await readTextIfPresent(join(consumer, DEPENDABOT_FILE)),
});

// Compose the generated Dependabot config from its on-disk sources, folding
// Dependabot semantic validation into the same problem list.
const composedDependabot = (
  sources: DependabotSources,
): {
  readonly composed: string | null;
  readonly problems: ReadonlyArray<string>;
} => {
  if (sources.base === null) {
    return {
      composed: null,
      problems: [
        `${DEPENDABOT_BASE_FILE} must exist; run \`bun standards sync\` to mirror it in`,
      ],
    };
  }
  const result = composeDependabot(sources.base, sources.local);
  if (result.composed === null) {
    return result;
  }
  const problems = inspectDependabot(result.composed);
  return problems.length > 0 ? { composed: null, problems } : result;
};

const dependabotProblems = async (
  consumer: string,
): Promise<ReadonlyArray<string>> => {
  const sources = await readDependabotSources(consumer);
  const { composed, problems } = composedDependabot(sources);
  if (composed === null) {
    return problems;
  }
  if (sources.current !== composed) {
    return [
      `${DEPENDABOT_FILE} does not match its composed sources; regenerate it with \`bun standards dependabot --write\``,
    ];
  }
  return [];
};

const writeComposedDependabot = async (
  consumer: string,
  composed: string,
): Promise<void> => {
  const dest = join(consumer, DEPENDABOT_FILE);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, composed);
};

const composeProblemsError = (problems: ReadonlyArray<string>): Error =>
  new Error(
    [
      `cannot compose ${DEPENDABOT_FILE}:`,
      ...problems.map((problem) => `  - ${problem}`),
    ].join('\n'),
  );

type ProspectiveDependabot = {
  readonly composed: string;
  readonly current: string | null;
};

// Validate the incoming canonical base against the effective local overlay
// before init/sync mutates any consumer-owned, canonical, generated, or lock
// file. For init, an existing overlay wins; otherwise the overlay seed is what
// the command is about to install.
const prepareProspectiveDependabot = async (
  manifest: Manifest,
  srcDir: string,
  consumer: string,
  localSeed: string | null,
): Promise<ProspectiveDependabot> => {
  const incoming = await listManaged(srcDir, manifest.paths);
  const basePath = incoming.get(DEPENDABOT_BASE_FILE);
  if (basePath === undefined) {
    throw new Error(
      `source content must manage ${DEPENDABOT_BASE_FILE}; @davidvornholt/standards 0.10 requires a 0.10-compatible content ref`,
    );
  }
  const existingLocal = await readTextIfPresent(
    join(consumer, DEPENDABOT_LOCAL_FILE),
  );
  const local =
    existingLocal ??
    (localSeed === null ? null : await readFile(localSeed, 'utf8'));
  const current = await readTextIfPresent(join(consumer, DEPENDABOT_FILE));
  const sources = {
    base: await readFile(basePath, 'utf8'),
    local,
    current,
  };
  const { composed, problems } = composedDependabot(sources);
  if (composed === null) {
    throw composeProblemsError(problems);
  }
  return { composed, current };
};

const applyProspectiveDependabot = async (
  consumer: string,
  prospective: ProspectiveDependabot,
  dryRun: boolean,
): Promise<void> => {
  if (prospective.current === prospective.composed) {
    return;
  }
  if (dryRun) {
    console.log(`  would generate ${DEPENDABOT_FILE}`);
    return;
  }
  await writeComposedDependabot(consumer, prospective.composed);
  console.log(`  generated ${DEPENDABOT_FILE}`);
};

const runDependabotCheck = async (consumer: string): Promise<boolean> => {
  const problems = await dependabotProblems(consumer);
  if (problems.length > 0) {
    console.error(`standards dependabot: ${problems.length} problem(s):`);
    console.error(problems.map((problem) => `  - ${problem}`).join('\n'));
    return false;
  }
  console.log(
    `standards dependabot: ${DEPENDABOT_FILE} matches its composed sources`,
  );
  return true;
};

const runDependabotWrite = async (consumer: string): Promise<void> => {
  const sources = await readDependabotSources(consumer);
  const { composed, problems } = composedDependabot(sources);
  if (composed === null) {
    throw composeProblemsError(problems);
  }
  if (sources.current === composed) {
    console.log(`standards dependabot: ${DEPENDABOT_FILE} is up to date`);
    return;
  }
  await writeComposedDependabot(consumer, composed);
  console.log(`standards dependabot: generated ${DEPENDABOT_FILE}`);
};

const inspectPackageJson = (packageRaw: string): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(packageRaw);
  } catch {
    return ['package.json must contain valid JSON'];
  }
  if (!isRecord(packageJson)) {
    return ['package.json must contain a JSON object'];
  }
  const scripts = isRecord(packageJson.scripts) ? packageJson.scripts : {};
  const devDependencies = isRecord(packageJson.devDependencies)
    ? packageJson.devDependencies
    : {};
  if (typeof devDependencies?.['@davidvornholt/standards'] !== 'string') {
    problems.push(
      'package.json must declare @davidvornholt/standards directly',
    );
  }
  for (const name of ['check', 'check:fix']) {
    const script = scripts?.[name];
    if (
      typeof script !== 'string' ||
      !hasSafeCommand(script, 'standards check')
    ) {
      problems.push(`package.json script "${name}" must run standards check`);
    }
  }
  return problems;
};

const runDoctor = async (consumer: string): Promise<boolean> => {
  const problems: Array<string> = [];
  const biome = await readTextIfPresent(join(consumer, 'biome.jsonc'));
  if (biome === null || !biome.includes('"./biome.base.jsonc"')) {
    problems.push('biome.jsonc must extend "./biome.base.jsonc"');
  }

  if (!existsSync(join(consumer, 'AGENTS.local.md'))) {
    problems.push('AGENTS.local.md must exist for project-specific guidance');
  }

  problems.push(...(await dependabotProblems(consumer)));

  const packagePath = join(consumer, 'package.json');
  const packageRaw = await readTextIfPresent(packagePath);
  if (packageRaw === null) {
    problems.push('package.json must exist');
  } else {
    problems.push(...inspectPackageJson(packageRaw));
  }

  // The GitHub settings seam only exists once the canonical declaration has
  // been synced in; before that there is nothing to extend.
  const canonicalSettings = await readTextIfPresent(
    join(consumer, CANONICAL_SETTINGS_FILE),
  );
  if (canonicalSettings !== null) {
    const localSettings = await readTextIfPresent(
      join(consumer, LOCAL_SETTINGS_FILE),
    );
    problems.push(
      ...loadGithubSettings(canonicalSettings, localSettings).problems,
    );
  }

  problems.push(...(await inspectPolicy(consumer)));

  if (problems.length > 0) {
    console.error(
      `standards doctor: ${problems.length} integration problem(s):`,
    );
    console.error(problems.map((problem) => `  - ${problem}`).join('\n'));
    return false;
  }
  console.log('standards doctor: consumer integration seams are wired');
  return true;
};

const USAGE = `Usage: standards <command> [options]

Commands:
  init        Bootstrap a consumer repo: seed repo-owned files, mirror canonical files, write the lock
  sync        Mirror canonical files from upstream, regenerate the composed Dependabot config, and rewrite the lock
  check       Verify canonical files, extension seams, monorepo structure, and GitHub settings
  doctor      Validate extension seams only
  structure   Validate monorepo structure rules only
  dependabot  Verify (--check) or regenerate (--write) the composed .github/dependabot.yml
  github      Compare (--check) or converge (--apply) live GitHub settings
  help        Show this help

Options:
  --dir <path>   Consumer directory to operate on (default: current directory)
  --profile <p>  With structure: validate as a "consumer" (default) or as the standards "source" repository itself
  --from <src>   Upstream override for init/sync (GitHub repo or local path)
  --ref <ref>    Upstream tag, branch, or full commit sha for init/sync (remote Git/GitHub sources only; default: main)
  --dry-run      Preview a sync without writing anything
  --check        With github/dependabot: compare against the declared sources (default)
  --apply        With github: converge the live repository (needs admin auth)
  --write        With dependabot: regenerate the composed .github/dependabot.yml`;

const commandFromArg = (arg: string): Command => {
  if (
    arg === 'check' ||
    arg === 'dependabot' ||
    arg === 'doctor' ||
    arg === 'github' ||
    arg === 'help' ||
    arg === 'init' ||
    arg === 'structure' ||
    arg === 'sync'
  ) {
    return arg;
  }
  throw new Error(
    arg.startsWith('--') ? `Unknown option: ${arg}` : `Unknown command: ${arg}`,
  );
};

const setCommand = (current: Command | undefined, next: Command): Command => {
  if (current !== undefined) {
    throw new Error(`Unexpected second command: ${next}`);
  }
  return next;
};

const structureProfileOf = (value: string): StructureProfile => {
  if (value === 'consumer' || value === 'source') {
    return value;
  }
  throw new Error(`--profile must be "consumer" or "source": ${value}`);
};

const nextOptionValue = (
  argv: ReadonlyArray<string>,
  index: number,
): string => {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${argv[index]} requires a value`);
  }
  return value;
};

type ParsedFlags = {
  readonly command: Command | undefined;
  readonly checkFlag: boolean;
  readonly apply: boolean;
  readonly write: boolean;
  readonly ref: string | undefined;
  readonly profile: StructureProfile | undefined;
};

// Every option is only meaningful with specific commands; reject the rest so a
// typo fails loudly instead of silently doing the default thing.
const assertOptionUsage = (flags: ParsedFlags): void => {
  const { command, checkFlag, apply, write, ref, profile } = flags;
  if (checkFlag && command !== 'github' && command !== 'dependabot') {
    throw new Error(
      '--check is only valid with the github and dependabot commands',
    );
  }
  if (apply && command !== 'github') {
    throw new Error('--apply is only valid with the github command');
  }
  if (apply && checkFlag) {
    throw new Error('github accepts exactly one of --check or --apply');
  }
  if (write && command !== 'dependabot') {
    throw new Error('--write is only valid with the dependabot command');
  }
  if (write && checkFlag) {
    throw new Error('dependabot accepts exactly one of --check or --write');
  }
  if (ref !== undefined && command !== 'init' && command !== 'sync') {
    throw new Error('--ref is only valid with the init and sync commands');
  }
  if (profile !== undefined && command !== 'structure') {
    throw new Error('--profile is only valid with the structure command');
  }
};

const parseArgs = (argv: ReadonlyArray<string>): CliOptions => {
  let command: Command | undefined;
  let consumer = process.cwd();
  let dryRun = false;
  let from: string | undefined;
  let ref: string | undefined;
  let checkFlag = false;
  let apply = false;
  let write = false;
  let profile: StructureProfile | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--apply':
        apply = true;
        break;
      case '--check':
        checkFlag = true;
        break;
      case '--write':
        write = true;
        break;
      case '--dir':
        consumer = nextOptionValue(argv, index);
        index += 1;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--from':
        from = nextOptionValue(argv, index);
        index += 1;
        break;
      case '--profile':
        profile = structureProfileOf(nextOptionValue(argv, index));
        index += 1;
        break;
      case '--ref':
        ref = nextOptionValue(argv, index);
        index += 1;
        break;
      case '--help':
      case '-h':
        command = setCommand(command, 'help');
        break;
      default:
        command = setCommand(command, commandFromArg(arg));
    }
  }

  assertOptionUsage({ command, checkFlag, apply, write, ref, profile });

  return {
    command,
    consumer: resolve(consumer),
    dryRun,
    from,
    ref,
    apply,
    write,
    profile: profile ?? 'consumer',
  };
};

// Canonical monorepo structure gate: workspace and root script shapes,
// internal versioning, `exports`, tsconfig inheritance, and a11y wiring.
// The `source` profile instead pins the standards template repository's own
// deliberate exceptions to the consumer contract.
const runStructure = async (
  consumer: string,
  profile: StructureProfile,
): Promise<boolean> => {
  const problems = await collectStructureProblems(consumer, profile);
  if (problems.length > 0) {
    console.error(
      `standards structure: ${problems.length} monorepo structure problem(s):`,
    );
    console.error(problems.map((problem) => `  - ${problem}`).join('\n'));
    return false;
  }
  console.log('standards structure: workspace layout matches the standards');
  return true;
};

const runCheckCommand = async (consumer: string): Promise<boolean> => {
  const driftIsClean = await runCheck(consumer);
  const integrationIsValid = await runDoctor(consumer);
  const structureIsValid = await runStructure(consumer, 'consumer');
  // The GitHub gate activates with the synced declaration and then fails
  // closed: once .github/settings.json exists, an unreachable API or an
  // unreadable origin is a failure, not a skip.
  const githubIsConverged = existsSync(join(consumer, CANONICAL_SETTINGS_FILE))
    ? await runGithubCheck(consumer)
    : true;
  return (
    driftIsClean && integrationIsValid && structureIsValid && githubIsConverged
  );
};

// Consumer-owned sync policy, checked in next to the canonical (read-only)
// standards-sync workflow it configures — versioned and reviewable, unlike
// repository Actions variables. All fields are optional; a missing file means
// the defaults (track main, weekly auto-sync on).
//   autoSync  false skips the scheduled workflow run; manual dispatch and
//             local CLI runs are deliberate acts and always proceed.
//   ref       tag, branch, or full commit sha to sync from instead of main.
const POLICY_FILE = 'sync-standards.local.json';
const LINE_BREAK = /[\r\n]/u;

type Policy = {
  readonly autoSync?: boolean;
  readonly ref?: string;
};

const parsePolicy = (parsed: unknown): Policy => {
  if (!isRecord(parsed)) {
    throw new Error(`${POLICY_FILE} must be a JSON object`);
  }
  const unsupportedFields = Object.keys(parsed).filter(
    (field) => field !== 'autoSync' && field !== 'ref',
  );
  if (unsupportedFields.length > 0) {
    throw new Error(
      `${POLICY_FILE} contains unsupported field(s): ${unsupportedFields.join(', ')}`,
    );
  }
  if (parsed.autoSync !== undefined && typeof parsed.autoSync !== 'boolean') {
    throw new Error(`${POLICY_FILE} "autoSync" must be a boolean`);
  }
  if (
    parsed.ref !== undefined &&
    (!isNonEmptyString(parsed.ref) || LINE_BREAK.test(parsed.ref))
  ) {
    throw new Error(
      `${POLICY_FILE} "ref" must be a non-empty single-line string`,
    );
  }
  return { autoSync: parsed.autoSync, ref: parsed.ref };
};

const readPolicy = async (consumer: string): Promise<Policy> => {
  const raw = await readTextIfPresent(join(consumer, POLICY_FILE));
  if (raw === null) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${POLICY_FILE} must contain valid JSON`, { cause: error });
  }
  return parsePolicy(parsed);
};

const inspectPolicy = async (
  consumer: string,
): Promise<ReadonlyArray<string>> => {
  try {
    await readPolicy(consumer);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
};

// Policy validation is unconditional once the file exists. Selection happens
// afterward: explicit refs win for remote sources, while local paths are used
// as-is and ignore only the already-validated policy ref.
const selectedRef = (
  src: string,
  explicitRef: string | undefined,
  policy: Policy,
): string | undefined =>
  existsSync(src) ? explicitRef : (explicitRef ?? policy.ref);

const runInitCommand = async (
  consumer: string,
  from: string | undefined,
  ref: string | undefined,
): Promise<void> => {
  // Refuse before cloning upstream: re-initializing skips the lock, so it
  // would silently overwrite local canonical edits and orphan files that
  // upstream deleted (they leave the lock and no future sync removes them).
  if (existsSync(join(consumer, 'sync-standards.lock'))) {
    console.error(
      'standards: already initialized (sync-standards.lock exists). Use `bun standards sync` to update.',
    );
    process.exitCode = 1;
    return;
  }
  const src = from ?? DEFAULT_UPSTREAM;
  const policy = await readPolicy(consumer);
  const source = resolveSource(src, selectedRef(src, ref, policy));
  try {
    const manifest = await loadManifest(
      join(source.dir, 'sync-standards.json'),
    );
    await runInit(manifest, source, consumer);
  } finally {
    source.cleanup();
  }
};

const runSyncCommand = async (
  consumer: string,
  from: string | undefined,
  ref: string | undefined,
  dryRun: boolean,
): Promise<void> => {
  const consumerManifest = await loadManifest(
    join(consumer, 'sync-standards.json'),
  );
  const src = from ?? consumerManifest.upstream;
  const policy = await readPolicy(consumer);
  const source = resolveSource(src, selectedRef(src, ref, policy));
  try {
    const manifest = await loadManifest(
      join(source.dir, 'sync-standards.json'),
    );
    await runSync(manifest, source, consumer, dryRun);
  } finally {
    source.cleanup();
  }
};

// Commands whose success is reported through the exit code.
const runGateCommand = (
  command: 'check' | 'dependabot' | 'doctor' | 'github' | 'structure',
  consumer: string,
  apply: boolean,
  profile: StructureProfile,
): Promise<boolean> => {
  if (command === 'check') {
    return runCheckCommand(consumer);
  }
  if (command === 'dependabot') {
    return runDependabotCheck(consumer);
  }
  if (command === 'doctor') {
    return runDoctor(consumer);
  }
  if (command === 'structure') {
    return runStructure(consumer, profile);
  }
  return apply ? runGithubApply(consumer) : runGithubCheck(consumer);
};

const main = async (): Promise<void> => {
  const { command, consumer, dryRun, from, ref, apply, write, profile } =
    parseArgs(process.argv.slice(2));

  if (command === undefined) {
    console.error('standards: a command is required\n');
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  if (command === 'help') {
    console.log(USAGE);
    return;
  }

  if (command === 'init') {
    await runInitCommand(consumer, from, ref);
    return;
  }

  if (command === 'sync') {
    await runSyncCommand(consumer, from, ref, dryRun);
    return;
  }

  if (command === 'dependabot' && write) {
    await runDependabotWrite(consumer);
    return;
  }

  if (!(await runGateCommand(command, consumer, apply, profile))) {
    process.exitCode = 1;
  }
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

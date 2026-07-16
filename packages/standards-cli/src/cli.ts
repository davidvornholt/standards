#!/usr/bin/env bun

// Standards CLI. Mirrors upstream-owned ("bucket 1") files from the
// davidvornholt/standards template into a consumer repo and detects local
// tampering with them. See the standards repository README for the design.
//
// This script is intentionally zero-dependency (Bun + Node built-ins only) and
// does NOT use Effect: `bunx` must be able to execute the published package
// before a consumer has dependencies. That is the documented exception to the
// repo's Effect standard for standalone bootstrap tooling.

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
import { CANONICAL_SETTINGS_FILE, LOCAL_SETTINGS_FILE } from './github-api';
import { runGithubApply, runGithubCheck } from './github-commands';
import { loadGithubSettings } from './github-settings';
import { collectStructureProblems } from './structure-check';
import { hasSafeCommand } from './structure-workspace';

const { YAML: BunYaml } = await import('bun');

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
  const lock = await readLock(consumer);
  const result = await mirror({
    manifest,
    srcDir: src.dir,
    consumer,
    previous: lock?.files ?? {},
    dryRun,
  });
  reportMirror(result, dryRun);
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
      `standards: ${problems.length} canonical file(s) drifted from upstream:`,
    );
    console.error(problems.join('\n'));
    console.error(
      'These files are read-only. Restore them with `bun standards sync`, or move your change upstream.',
    );
    return false;
  }
  console.log(
    `standards: ${Object.keys(lock.files).length} canonical file(s) match upstream`,
  );
  return true;
};

const readTextIfPresent = async (path: string): Promise<string | null> =>
  existsSync(path) ? readFile(path, 'utf8') : null;

const DEPENDABOT_BASELINE_ECOSYSTEMS = ['bun', 'github-actions'] as const;
const DEPENDABOT_SCHEDULE_INTERVALS = new Set([
  'daily',
  'weekly',
  'monthly',
  'quarterly',
  'semiannually',
  'yearly',
  'cron',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

type DependabotUpdateInspection = {
  readonly problems: ReadonlyArray<string>;
  readonly rootEcosystem: string | null;
};

const inspectDependabotSchedule = (
  schedule: unknown,
  label: string,
): ReadonlyArray<string> => {
  if (!(isRecord(schedule) && isNonEmptyString(schedule.interval))) {
    return [`${label} must define schedule.interval`];
  }
  if (!DEPENDABOT_SCHEDULE_INTERVALS.has(schedule.interval)) {
    return [`${label} has an unsupported schedule.interval`];
  }
  if (schedule.interval === 'cron' && !isNonEmptyString(schedule.cronjob)) {
    return [`${label} must define schedule.cronjob for a cron interval`];
  }
  return [];
};

type DependabotGroupInspection = {
  readonly problems: ReadonlyArray<string>;
  readonly scheduledGroups: ReadonlySet<string>;
};

const inspectDependabotGroups = (
  groups: unknown,
): DependabotGroupInspection => {
  if (groups === undefined) {
    return { problems: [], scheduledGroups: new Set() };
  }
  if (!isRecord(groups)) {
    return {
      problems: [
        '.github/dependabot.yml multi-ecosystem-groups must be a mapping',
      ],
      scheduledGroups: new Set(),
    };
  }

  const problems: Array<string> = [];
  const scheduledGroups = new Set<string>();
  for (const [name, group] of Object.entries(groups)) {
    const label = `.github/dependabot.yml multi-ecosystem-groups.${name}`;
    const groupProblems = isRecord(group)
      ? inspectDependabotSchedule(group.schedule, label)
      : [`${label} must be a mapping`];
    problems.push(...groupProblems);
    if (groupProblems.length === 0) {
      scheduledGroups.add(name);
    }
  }
  return { problems, scheduledGroups };
};

const inspectDependabotUpdate = (
  update: unknown,
  index: number,
  scheduledGroups: ReadonlySet<string>,
): DependabotUpdateInspection => {
  const label = `.github/dependabot.yml updates[${index}]`;
  if (!isRecord(update)) {
    return { problems: [`${label} must be a mapping`], rootEcosystem: null };
  }

  const {
    directory,
    directories,
    schedule,
    'multi-ecosystem-group': multiEcosystemGroup,
    'package-ecosystem': ecosystem,
  } = update;
  const problems: Array<string> = [];
  if (!isNonEmptyString(ecosystem)) {
    problems.push(`${label} must define package-ecosystem`);
  }

  const hasDirectory = isNonEmptyString(directory);
  const hasDirectories =
    Array.isArray(directories) &&
    directories.length > 0 &&
    directories.every(isNonEmptyString);
  if (hasDirectory === hasDirectories) {
    problems.push(
      `${label} must define exactly one of directory or directories`,
    );
  }

  if (schedule === undefined && isNonEmptyString(multiEcosystemGroup)) {
    if (!scheduledGroups.has(multiEcosystemGroup)) {
      problems.push(
        `${label} must reference a scheduled multi-ecosystem group`,
      );
    }
  } else {
    problems.push(...inspectDependabotSchedule(schedule, label));
  }

  const targetsRoot =
    directory === '/' ||
    (Array.isArray(directories) && directories.includes('/'));
  return {
    problems,
    rootEcosystem:
      isNonEmptyString(ecosystem) && targetsRoot ? ecosystem : null,
  };
};

const inspectDependabot = (raw: string): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  let config: unknown;
  try {
    config = BunYaml.parse(raw);
  } catch {
    return ['.github/dependabot.yml must contain valid YAML'];
  }

  if (!isRecord(config)) {
    return ['.github/dependabot.yml must contain a YAML mapping'];
  }
  if (config.version !== 2) {
    problems.push('.github/dependabot.yml must use version: 2');
  }

  const { updates, 'multi-ecosystem-groups': multiEcosystemGroups } = config;
  if (!Array.isArray(updates)) {
    problems.push('.github/dependabot.yml must define an updates list');
    return problems;
  }

  const groupInspection = inspectDependabotGroups(multiEcosystemGroups);
  problems.push(...groupInspection.problems);
  const rootEcosystems = new Set<string>();
  for (const [index, update] of updates.entries()) {
    const inspection = inspectDependabotUpdate(
      update,
      index,
      groupInspection.scheduledGroups,
    );
    problems.push(...inspection.problems);
    if (inspection.rootEcosystem !== null) {
      rootEcosystems.add(inspection.rootEcosystem);
    }
  }

  for (const ecosystem of DEPENDABOT_BASELINE_ECOSYSTEMS) {
    if (!rootEcosystems.has(ecosystem)) {
      problems.push(
        `.github/dependabot.yml must include a root-directory ${ecosystem} ecosystem`,
      );
    }
  }
  return problems;
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

  const dependabot = await readTextIfPresent(
    join(consumer, '.github/dependabot.yml'),
  );
  if (dependabot === null) {
    problems.push('.github/dependabot.yml must exist');
  } else {
    problems.push(...inspectDependabot(dependabot));
  }

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
  init       Bootstrap a consumer repo: seed repo-owned files, mirror canonical files, write the lock
  sync       Mirror canonical files from upstream and rewrite the lock
  check      Verify canonical files, extension seams, monorepo structure, and GitHub settings
  doctor     Validate extension seams only
  structure  Validate monorepo structure rules only
  github     Compare (--check) or converge (--apply) live GitHub settings
  help       Show this help

Options:
  --dir <path>   Consumer directory to operate on (default: current directory)
  --from <src>   Upstream override for init/sync (GitHub repo or local path)
  --ref <ref>    Upstream tag, branch, or full commit sha for init/sync (remote Git/GitHub sources only; default: main)
  --dry-run      Preview a sync without writing anything
  --check        With github: compare live settings to the declaration (default)
  --apply        With github: converge the live repository (needs admin auth)`;

const commandFromArg = (arg: string): Command => {
  if (
    arg === 'check' ||
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

const parseArgs = (argv: ReadonlyArray<string>): CliOptions => {
  let command: Command | undefined;
  let consumer = process.cwd();
  let dryRun = false;
  let from: string | undefined;
  let ref: string | undefined;
  let checkFlag = false;
  let apply = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--apply':
        apply = true;
        break;
      case '--check':
        checkFlag = true;
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

  if (checkFlag && command !== 'github') {
    throw new Error('--check is only valid with the github command');
  }
  if (apply && command !== 'github') {
    throw new Error('--apply is only valid with the github command');
  }
  if (apply && checkFlag) {
    throw new Error('github accepts exactly one of --check or --apply');
  }
  if (ref !== undefined && command !== 'init' && command !== 'sync') {
    throw new Error('--ref is only valid with the init and sync commands');
  }

  return {
    command,
    consumer: resolve(consumer),
    dryRun,
    from,
    ref,
    apply,
  };
};

// Canonical monorepo structure gate: workspace and root script shapes,
// internal versioning, `exports`, tsconfig inheritance, and a11y wiring.
const runStructure = async (consumer: string): Promise<boolean> => {
  const problems = await collectStructureProblems(consumer);
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
  const structureIsValid = await runStructure(consumer);
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

type Policy = {
  readonly autoSync?: boolean;
  readonly ref?: string;
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
  if (!isRecord(parsed)) {
    throw new Error(`${POLICY_FILE} must be a JSON object`);
  }
  if (parsed.autoSync !== undefined && typeof parsed.autoSync !== 'boolean') {
    throw new Error(`${POLICY_FILE} "autoSync" must be a boolean`);
  }
  if (parsed.ref !== undefined && !isNonEmptyString(parsed.ref)) {
    throw new Error(`${POLICY_FILE} "ref" must be a non-empty string`);
  }
  return { autoSync: parsed.autoSync, ref: parsed.ref };
};

// A policy pin applies only to remote sources: a local path is used as-is
// (see resolveSource), so a checked-in ref is not applicable to it. An
// explicit --ref against a local path still errors — that contradiction was
// typed deliberately.
const policyRef = async (
  consumer: string,
  src: string,
): Promise<string | undefined> =>
  existsSync(src) ? undefined : (await readPolicy(consumer)).ref;

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
  const source = resolveSource(src, ref ?? (await policyRef(consumer, src)));
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
  const source = resolveSource(src, ref ?? (await policyRef(consumer, src)));
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
  command: 'check' | 'doctor' | 'github' | 'structure',
  consumer: string,
  apply: boolean,
): Promise<boolean> => {
  if (command === 'check') {
    return runCheckCommand(consumer);
  }
  if (command === 'doctor') {
    return runDoctor(consumer);
  }
  if (command === 'structure') {
    return runStructure(consumer);
  }
  return apply ? runGithubApply(consumer) : runGithubCheck(consumer);
};

const main = async (): Promise<void> => {
  const { command, consumer, dryRun, from, ref, apply } = parseArgs(
    process.argv.slice(2),
  );

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

  if (!(await runGateCommand(command, consumer, apply))) {
    process.exitCode = 1;
  }
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

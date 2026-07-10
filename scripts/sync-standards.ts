// Standards sync engine. Mirrors upstream-owned ("bucket 1") files from the
// davidvornholt/standards template into a consumer repo and detects local
// tampering with them. See docs/standards-template.md for the full design.
//
// This script is intentionally zero-dependency (Bun + Node built-ins only) and
// does NOT use Effect: it must run standalone when fetched raw during the
// bootstrap one-liner. That is the one documented exception to the repo's
// Effect standard, justified because this is standalone bootstrap tooling.

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
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

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

const sha256 = (buf: Buffer): string =>
  createHash('sha256').update(buf).digest('hex');

const toPosix = (p: string): string => p.split(sep).join('/');

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
// shorthand, or any git URL.
const resolveSource = (src: string): Source => {
  if (existsSync(src)) {
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
  const dir = mkdtempSync(join(tmpdir(), 'standards-'));
  execFileSync('git', ['clone', '--depth', '1', '--branch', 'main', url, dir], {
    stdio: 'ignore',
  });
  const sha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  return {
    dir,
    sha,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
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
// on — see the "known limitation" in docs/standards-template.md.
const runCheck = async (consumer: string): Promise<boolean> => {
  const lock = await readLock(consumer);
  if (lock === null || Object.keys(lock.files).length === 0) {
    console.log('sync-standards: no synced files to check');
    return true;
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
      `sync-standards: ${problems.length} canonical file(s) drifted from upstream:`,
    );
    console.error(problems.join('\n'));
    console.error(
      'These files are read-only. Restore them with `just sync-standards`, or move your change upstream.',
    );
    return false;
  }
  console.log(
    `sync-standards: ${Object.keys(lock.files).length} canonical file(s) match upstream`,
  );
  return true;
};

const optionValue = (
  argv: ReadonlyArray<string>,
  name: string,
): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const positional = argv.filter((a) => !a.startsWith('--'));
  const command = argv.includes('--check')
    ? 'check'
    : (positional[0] ?? 'sync');
  const consumer = resolve(optionValue(argv, 'dir') ?? process.cwd());

  if (command === 'check') {
    if (!(await runCheck(consumer))) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'init') {
    // Refuse before cloning upstream: re-initializing skips the lock, so it
    // would silently overwrite local canonical edits and orphan files that
    // upstream deleted (they leave the lock and no future sync removes them).
    if (existsSync(join(consumer, 'sync-standards.lock'))) {
      console.error(
        'sync-standards: already initialized (sync-standards.lock exists). Use `just sync-standards` to update.',
      );
      process.exitCode = 1;
      return;
    }
    const source = resolveSource(optionValue(argv, 'from') ?? DEFAULT_UPSTREAM);
    try {
      const manifest = await loadManifest(
        join(source.dir, 'sync-standards.json'),
      );
      await runInit(manifest, source, consumer);
    } finally {
      source.cleanup();
    }
    return;
  }

  if (command === 'sync') {
    const consumerManifest = await loadManifest(
      join(consumer, 'sync-standards.json'),
    );
    const source = resolveSource(
      optionValue(argv, 'from') ?? consumerManifest.upstream,
    );
    try {
      const manifest = await loadManifest(
        join(source.dir, 'sync-standards.json'),
      );
      await runSync(manifest, source, consumer, argv.includes('--dry-run'));
    } finally {
      source.cleanup();
    }
    return;
  }

  console.error(
    `Unknown command: ${command}. Expected init, sync, or --check.`,
  );
  process.exitCode = 1;
};

await main();

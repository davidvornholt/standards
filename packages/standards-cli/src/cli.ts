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
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { gitChildEnvironment } from './git-child-environment';
import { CANONICAL_SETTINGS_FILE, LOCAL_SETTINGS_FILE } from './github-api';
import { runGithubApply, runGithubCheck } from './github-commands';
import { loadGithubSettings } from './github-settings';
import {
  classifyReservedSyncTarget,
  SYNC_LOCK_FILE,
} from './sync-control-seams';
import {
  inspectRepositoryFile,
  inspectRepositoryFiles,
} from './sync-file-inspection';
import {
  assertRepositoryRelativePath,
  type FileState,
  fileStatesMatch,
  inspectRepositoryDirectories,
  inspectRepositoryNode,
  openRepositoryRoot,
  type RepositoryRoot,
} from './sync-filesystem';
import { ensureGitRecoveryArtifactsExcluded } from './sync-git-exclude';
import {
  applyRepositoryMutations,
  type PreparedDelete,
  type PreparedWrite,
} from './sync-mutations';
import {
  DEFAULT_SYNC_POLICY,
  inspectSyncPolicy,
  SYNC_POLICY_CONTRACT_VERSION,
  SYNC_POLICY_FILE,
  type SyncPolicy,
  type SyncPolicyInspection,
} from './sync-policy';
import { IGNORED_SOURCE_DIRECTORY_NAMES, type SourceFile } from './sync-source';
import {
  loadSourceManifest,
  type Manifest,
  selectSourceTrees,
} from './sync-source-selection';
import { recoverRepositoryTransactions } from './sync-transaction-recovery';

const { YAML: BunYaml } = await import('bun');

const DEFAULT_UPSTREAM = 'github:davidvornholt/standards';
const SYNC_POLICY_CONTROLLER_PATH = '.github/actions/standards-sync-preflight';
const SYNC_POLICY_CONTRACT_FILE = `${SYNC_POLICY_CONTROLLER_PATH}/index.mjs`;
const SYNC_POLICY_CONTROLLER_FILES = ['action.yml', 'index.mjs'] as const;
const SYNC_POLICY_GENERATION_EXPORT =
  /\bSYNC_POLICY_CONTRACT_VERSION=(?<version>\d+)\b/u;
// Locks written before seed ownership was persisted need the complete seed set
// shipped by the contract-v1 template. Keep this migration baseline forever:
// a selected source may omit a seed, but that must not make it managed again.
const CONTRACT_V1_SEED_OWNERSHIP_BASELINE = [
  '.agents/review/decisions.md',
  '.github/dependabot.yml',
  '.github/settings.local.json',
  '.sops.yaml',
  'AGENTS.local.md',
  'README.md',
  'biome.jsonc',
  'package.json',
  'secrets/ci.example.yaml',
  'secrets/dev.example.yaml',
  'sync-standards.local.json',
  'turbo.json',
] as const;

// Characters of a sha256 hex digest shown in drift reports; enough to identify.
const HASH_PREVIEW_LENGTH = 12;
const GITHUB_PREFIX = 'github:';
const FULL_COMMIT_SHA = /^[0-9a-fA-F]{40}$/u;
const STORED_COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const LOCK_KEYS = new Set(['files', 'ref', 'seeds', 'sha', 'upstream']);

type Lock = {
  readonly upstream: string;
  readonly ref?: string;
  readonly sha: string;
  readonly files: ReadonlyMap<string, string>;
  readonly seeds: ReadonlySet<string>;
};

type ConsumerSyncPolicyInspectionOptions = {
  readonly allowMissingDefaultContract: boolean;
  readonly policyState?: FileState;
  readonly policyText: string | undefined;
};

type ConsumerSyncPolicySnapshot = {
  readonly inspection: SyncPolicyInspection;
  readonly state: FileState;
};

type EffectiveSyncPolicy = {
  readonly policy: SyncPolicy;
  readonly state: FileState;
};

type Source = {
  readonly dir: string;
  readonly sha: string;
  readonly cleanup: () => void;
};

type LocalSourceMode = 'explicit' | 'persisted' | null;

type Command = 'check' | 'doctor' | 'github' | 'help' | 'init' | 'sync';

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
const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const isUnder = (path: string, parent: string): boolean =>
  path === parent || path.startsWith(`${parent}/`);

const assertNoReservedManagedTargets = (
  paths: ReadonlyArray<string>,
  label: string,
): void => {
  for (const path of paths) {
    const reserved = classifyReservedSyncTarget(path);
    if (reserved !== null) {
      throw new Error(
        `${label} "${path}" overlaps ${reserved.kind} "${reserved.target}"`,
      );
    }
  }
};

const assertNoCliOwnedSeedTargets = (
  paths: ReadonlyArray<string>,
  label: string,
): void => {
  for (const path of paths) {
    const reserved = classifyReservedSyncTarget(path);
    if (
      reserved !== null &&
      reserved.kind !== 'repository-owned control seam'
    ) {
      throw new Error(
        `${label} "${path}" overlaps ${reserved.kind} "${reserved.target}"`,
      );
    }
  }
};

const assertSafeRelativePath = assertRepositoryRelativePath;

const assertCompatibleSyncSource = (
  manifest: Manifest,
  managed: ReadonlyMap<string, SourceFile>,
  seeds: ReadonlyMap<string, SourceFile>,
): void => {
  if (manifest.syncPolicyContractVersion !== SYNC_POLICY_CONTRACT_VERSION) {
    throw new Error(
      `Selected standards source must declare syncPolicyContractVersion: ${SYNC_POLICY_CONTRACT_VERSION}; choose a ref that includes the sync-policy controller contract`,
    );
  }
  assertNoReservedManagedTargets(
    [...manifest.paths, ...managed.keys()],
    'Selected standards source managed path',
  );
  assertNoCliOwnedSeedTargets(
    [...seeds.keys()],
    'Selected standards source seed target',
  );
  if (!manifest.paths.includes(SYNC_POLICY_CONTROLLER_PATH)) {
    throw new Error(
      `syncPolicyContractVersion ${SYNC_POLICY_CONTRACT_VERSION} requires managed path "${SYNC_POLICY_CONTROLLER_PATH}"`,
    );
  }
  for (const file of SYNC_POLICY_CONTROLLER_FILES) {
    const path = `${SYNC_POLICY_CONTROLLER_PATH}/${file}`;
    if (!managed.has(path)) {
      throw new Error(
        `syncPolicyContractVersion ${SYNC_POLICY_CONTRACT_VERSION} requires controller file "${path}"`,
      );
    }
  }
  const contract = managed
    .get(SYNC_POLICY_CONTRACT_FILE)
    ?.contents.toString('utf8');
  const generation = contract?.match(SYNC_POLICY_GENERATION_EXPORT)?.groups
    ?.version;
  if (generation !== String(SYNC_POLICY_CONTRACT_VERSION)) {
    throw new Error(
      `${SYNC_POLICY_CONTRACT_FILE} must be generated for SYNC_POLICY_CONTRACT_VERSION = ${SYNC_POLICY_CONTRACT_VERSION}`,
    );
  }
};

const isFullCommitSha = (ref: string): boolean => FULL_COMMIT_SHA.test(ref);

const displaySourceUrl = (source: string): string => {
  try {
    const parsed = new URL(source);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '<redacted source>';
  }
};

const isExplicitLocalSource = (source: string): boolean =>
  existsSync(source) &&
  (isAbsolute(source) ||
    source === '.' ||
    source === '..' ||
    source.startsWith('./') ||
    source.startsWith('../'));

const assertSupportedRef = (ref: string): void => {
  const isQualified =
    ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/');
  if (!(isFullCommitSha(ref) || isQualified)) {
    throw new Error(
      `Unsupported ref "${ref}"; use refs/heads/<branch>, refs/tags/<tag>, or a full commit sha`,
    );
  }
  if (!isQualified) {
    return;
  }
  try {
    execFileSync('git', ['check-ref-format', ref], {
      env: gitChildEnvironment(),
      stdio: 'ignore',
    });
  } catch (error) {
    throw new Error(`Invalid qualified Git ref: ${ref}`, { cause: error });
  }
};

const syncPolicyContents = (policy: SyncPolicy): Buffer =>
  Buffer.from(`${JSON.stringify(policy, null, 2)}\n`);

type LockInspection = {
  readonly lock: Lock | null;
  readonly state: FileState;
};

const lockRecord = (parsed: unknown): Record<string, unknown> => {
  if (!isRecord(parsed)) {
    throw new Error('sync-standards.lock must be a JSON object');
  }
  for (const key of Object.keys(parsed)) {
    if (!LOCK_KEYS.has(key)) {
      throw new Error(`sync-standards.lock has unknown key "${key}"`);
    }
  }
  return parsed;
};

const lockMetadata = (
  parsed: Record<string, unknown>,
): Pick<Lock, 'ref' | 'sha' | 'upstream'> => {
  if (typeof parsed.upstream !== 'string' || parsed.upstream.length === 0) {
    throw new Error(
      'sync-standards.lock "upstream" must be a non-empty string',
    );
  }
  if (
    !(
      typeof parsed.sha === 'string' &&
      (parsed.sha === 'local' || STORED_COMMIT_SHA.test(parsed.sha))
    )
  ) {
    throw new Error(
      'sync-standards.lock "sha" must be "local" or a lowercase full Git commit ID',
    );
  }
  if (Object.hasOwn(parsed, 'ref') && typeof parsed.ref !== 'string') {
    throw new Error('sync-standards.lock "ref" must be a string');
  }
  const ref = parsed.ref as string | undefined;
  if (ref !== undefined) {
    assertSupportedRef(ref);
  }
  return { ref, sha: parsed.sha, upstream: parsed.upstream };
};

const lockFiles = (
  parsed: Record<string, unknown>,
): ReadonlyMap<string, string> => {
  if (!isRecord(parsed.files)) {
    throw new Error('sync-standards.lock "files" must be a JSON object');
  }
  const files = new Map<string, string>();
  for (const [rel, hash] of Object.entries(parsed.files)) {
    assertSafeRelativePath(rel, 'sync-standards.lock file');
    assertNoReservedManagedTargets([rel], 'sync-standards.lock file');
    if (typeof hash !== 'string' || !SHA256.test(hash)) {
      throw new Error(
        `sync-standards.lock file "${rel}" must have a lowercase SHA-256 hash`,
      );
    }
    files.set(rel, hash);
  }
  return files;
};

const lockSeeds = (parsed: Record<string, unknown>): ReadonlySet<string> => {
  const persisted = Object.hasOwn(parsed, 'seeds') ? parsed.seeds : [];
  if (!isStringArray(persisted)) {
    throw new Error('sync-standards.lock "seeds" must be a string array');
  }
  if (new Set(persisted).size !== persisted.length) {
    throw new Error('sync-standards.lock "seeds" must be unique');
  }
  for (const seed of persisted) {
    assertSafeRelativePath(seed, 'sync-standards.lock seed');
  }
  assertNoCliOwnedSeedTargets(persisted, 'sync-standards.lock seed');
  return new Set([...CONTRACT_V1_SEED_OWNERSHIP_BASELINE, ...persisted]);
};

const inspectLock = async (root: RepositoryRoot): Promise<LockInspection> => {
  const state = await inspectRepositoryFile(root, 'sync-standards.lock');
  if (state.contents === null) {
    return { lock: null, state };
  }
  const parsed = lockRecord(
    JSON.parse(state.contents.toString('utf8')) as unknown,
  );
  const metadata = lockMetadata(parsed);
  const files = lockFiles(parsed);
  const seeds = lockSeeds(parsed);
  assertNoOwnershipTransitions({
    establishedSeeds: seeds,
    managed: [],
    observedSeeds: [],
    previousManaged: [...files.keys()],
  });
  return {
    lock: { ...metadata, files, seeds },
    state,
  };
};

const lockContents = (lock: Lock): Buffer => {
  const files = Object.fromEntries(
    [...lock.files].sort(([a], [b]) => a.localeCompare(b)),
  );
  const ordered = {
    upstream: lock.upstream,
    ref: lock.ref ?? DEFAULT_SYNC_POLICY.ref,
    sha: lock.sha,
    files,
    seeds: [...lock.seeds].sort((a, b) => a.localeCompare(b)),
  };
  return Buffer.from(`${JSON.stringify(ordered, null, 2)}\n`);
};

const assertFetchedCommitObject = (
  dir: string,
  target: string,
  cleanup: () => void,
): void => {
  let fetchedObject: string;
  let fetchedType: string;
  try {
    fetchedObject = execFileSync(
      'git',
      ['-C', dir, 'rev-parse', '--verify', 'FETCH_HEAD'],
      { encoding: 'utf8', env: gitChildEnvironment() },
    ).trim();
    fetchedType = execFileSync(
      'git',
      ['-C', dir, 'cat-file', '-t', 'FETCH_HEAD'],
      { encoding: 'utf8', env: gitChildEnvironment() },
    ).trim();
  } catch (error) {
    cleanup();
    throw new Error(`Cannot verify fetched object ${target}`, { cause: error });
  }
  if (fetchedObject.toLowerCase() !== target.toLowerCase()) {
    cleanup();
    throw new Error(
      `Fetched object ${fetchedObject} does not match requested object ${target}`,
    );
  }
  if (fetchedType !== 'commit') {
    cleanup();
    throw new Error(
      `Raw object ${target} has type ${fetchedType}; full object IDs must identify a commit`,
    );
  }
};

// Fetch the template into a working directory. Accepts a local path (used to
// prove the engine before the public repo exists and in tests), a github:
// shorthand, or any git URL. Remote refs are namespace-qualified branches or
// tags, or full commit shas, so a same-named branch and tag cannot collide.
const resolveLocalSource = (
  src: string,
  ref: string | undefined,
  mode: Exclude<LocalSourceMode, null>,
): Source => {
  let canonical: string;
  try {
    canonical = realpathSync(src);
  } catch (error) {
    throw new Error(`Local standards source cannot be resolved: ${src}`, {
      cause: error,
    });
  }
  if (mode === 'persisted' && canonical !== src) {
    throw new Error(
      `Persisted local standards source must be its canonical absolute realpath: ${src}`,
    );
  }
  const sourceInfo = lstatSync(src);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) {
    throw new Error(`Local standards source must be a real directory: ${src}`);
  }
  if (ref !== undefined) {
    throw new Error(
      `--ref requires a git URL source; a local path is used as-is: ${src}`,
    );
  }
  let sha = 'local';
  try {
    sha = execFileSync('git', ['-C', src, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      env: gitChildEnvironment(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Not a git checkout; a content-independent marker is fine for local use.
  }
  return { dir: canonical, sha, cleanup: () => undefined };
};

const resolveSource = (
  src: string,
  ref: string | undefined,
  localMode: LocalSourceMode,
): Source => {
  if (localMode !== null) {
    return resolveLocalSource(src, ref, localMode);
  }
  const url = src.startsWith(GITHUB_PREFIX)
    ? `https://github.com/${src.slice(GITHUB_PREFIX.length)}.git`
    : src;
  const target = ref ?? DEFAULT_SYNC_POLICY.ref;
  const displayUrl = displaySourceUrl(url);
  assertSupportedRef(target);
  const dir = mkdtempSync(join(tmpdir(), 'standards-'));
  const cleanup = (): void => rmSync(dir, { recursive: true, force: true });
  try {
    // init + fetch instead of `clone --branch` so a full commit sha works as a
    // ref, not only tags and branches (GitHub serves reachable sha fetches).
    execFileSync('git', ['init', '--quiet', dir], {
      env: gitChildEnvironment(),
      stdio: 'ignore',
    });
    execFileSync(
      'git',
      ['-C', dir, 'fetch', '--quiet', '--depth', '1', '--', url, target],
      { env: gitChildEnvironment(), stdio: 'ignore' },
    );
  } catch (error) {
    cleanup();
    throw new Error(
      `Cannot fetch "${target}" from ${displayUrl}; expected a qualified branch or tag, or a full commit sha reachable on the remote`,
      { cause: error },
    );
  }
  if (isFullCommitSha(target)) {
    assertFetchedCommitObject(dir, target, cleanup);
  }
  try {
    execFileSync(
      'git',
      ['-C', dir, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'],
      { env: gitChildEnvironment(), stdio: 'ignore' },
    );
  } catch (error) {
    cleanup();
    throw new Error(
      `Cannot check out fetched ref "${target}" from ${displayUrl}`,
      {
        cause: error,
      },
    );
  }
  const sha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    env: gitChildEnvironment(),
  }).trim();
  return { dir, sha, cleanup };
};

const localSourceMode = (
  from: string | undefined,
  source: string,
): LocalSourceMode => {
  if (from === undefined) {
    return isAbsolute(source) ? 'persisted' : null;
  }
  return isExplicitLocalSource(source) ? 'explicit' : null;
};

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

const assertNoOwnershipTransitions = ({
  establishedSeeds,
  managed,
  observedSeeds,
  previousManaged,
}: {
  readonly establishedSeeds: ReadonlySet<string>;
  readonly managed: ReadonlyArray<string>;
  readonly observedSeeds: ReadonlyArray<string>;
  readonly previousManaged: ReadonlyArray<string>;
}): void => {
  for (const managedPath of previousManaged) {
    const seedPath = [...establishedSeeds].find(
      (seed) => isUnder(managedPath, seed) || isUnder(seed, managedPath),
    );
    if (seedPath !== undefined) {
      throw new Error(
        `Previously managed path "${managedPath}" overlaps repository-owned seed path "${seedPath}"; explicit ownership migration is required`,
      );
    }
  }
  for (const managedPath of managed) {
    const seedPath = [...establishedSeeds].find(
      (seed) => isUnder(managedPath, seed) || isUnder(seed, managedPath),
    );
    if (seedPath !== undefined) {
      throw new Error(
        `Managed path "${managedPath}" would take ownership of repository-owned seed path "${seedPath}"; explicit seed-to-managed migration is required`,
      );
    }
  }
  for (const seedPath of observedSeeds) {
    const managedPath = previousManaged.find(
      (previous) => isUnder(seedPath, previous) || isUnder(previous, seedPath),
    );
    if (managedPath !== undefined) {
      throw new Error(
        `Seed path "${seedPath}" would take ownership of previously managed path "${managedPath}"; explicit managed-to-seed migration is required`,
      );
    }
  }
};

type MirrorResult = {
  readonly files: ReadonlyMap<string, string>;
  readonly created: ReadonlyArray<string>;
  readonly updated: ReadonlyArray<string>;
  readonly deleted: ReadonlyArray<string>;
  readonly tampered: ReadonlyArray<string>;
};

type PreparedMirror = {
  readonly deletes: ReadonlyArray<PreparedDelete>;
  readonly prunePaths: ReadonlyArray<string>;
  readonly result: MirrorResult;
  readonly writes: ReadonlyArray<PreparedWrite>;
};

const requiredState = (
  states: ReadonlyMap<string, FileState>,
  rel: string,
): FileState => {
  const state = states.get(rel);
  if (state === undefined) {
    throw new Error(`Missing filesystem preflight: ${rel}`);
  }
  return state;
};

const prunePathsFor = (files: ReadonlyArray<string>): ReadonlyArray<string> => {
  const paths = new Set<string>();
  for (const file of files) {
    let parent = dirname(file);
    while (parent !== '.') {
      paths.add(parent);
      parent = dirname(parent);
    }
  }
  return [...paths];
};

const prepareMirror = ({
  managed,
  previous,
  states,
}: {
  readonly managed: ReadonlyMap<string, SourceFile>;
  readonly previous: ReadonlyMap<string, string>;
  readonly states: ReadonlyMap<string, FileState>;
}): PreparedMirror => {
  for (const rel of previous.keys()) {
    assertSafeRelativePath(rel, 'sync-standards.lock file');
  }
  assertNoReservedManagedTargets(
    [...previous.keys()],
    'sync-standards.lock file',
  );
  const next = new Map<string, string>();
  const created: Array<string> = [];
  const updated: Array<string> = [];
  const tampered: Array<string> = [];
  const writes: Array<PreparedWrite> = [];
  for (const [rel, source] of managed) {
    const before = requiredState(states, rel);
    const currentHash =
      before.contents === null ? null : sha256(before.contents);
    const hash = sha256(source.contents);
    const previousHash = previous.get(rel);
    if (
      previousHash !== undefined &&
      currentHash !== null &&
      currentHash !== previousHash
    ) {
      tampered.push(rel);
    }
    if (currentHash === null) {
      created.push(rel);
    } else if (currentHash !== hash) {
      updated.push(rel);
    }
    if (currentHash !== hash) {
      writes.push({
        before,
        contents: source.contents,
        mode: before.mode,
        rel,
      });
    }
    next.set(rel, hash);
  }
  const deleted = [...previous.keys()].filter(
    (rel) => !next.has(rel) && requiredState(states, rel).contents !== null,
  );
  return {
    deletes: deleted.map((rel) => ({
      before: requiredState(states, rel),
      rel,
    })),
    prunePaths: prunePathsFor(deleted),
    result: { files: next, created, updated, deleted, tampered },
    writes,
  };
};

// Print what a mirror did (or, for a dry run, would do). Real syncs stay quiet
// about unchanged files and only announce deletions and clobbered local edits.
const reportDryRun = (
  result: MirrorResult,
  lockMetadataChanged: boolean,
  policyChanged: boolean,
): void => {
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
  if (lockMetadataChanged) {
    console.log('  would update sync-standards.lock (metadata)');
  }
  if (policyChanged) {
    console.log('  would update sync-standards.local.json (sync policy)');
  }
  const changes =
    result.created.length + result.updated.length + result.deleted.length;
  console.log(
    changes === 0 && !lockMetadataChanged && !policyChanged
      ? 'dry run: already in sync; no changes'
      : `dry run: ${result.created.length} to create, ${result.updated.length} to update, ${result.deleted.length} to delete, ${lockMetadataChanged ? 1 : 0} lock metadata update(s), ${policyChanged ? 1 : 0} sync policy update(s)`,
  );
};

const reportMirror = (
  result: MirrorResult,
  dryRun: boolean,
  lockMetadataChanged = false,
  policyChanged = false,
): void => {
  if (dryRun) {
    reportDryRun(result, lockMetadataChanged, policyChanged);
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

type RunInitOptions = {
  readonly consumer: RepositoryRoot;
  readonly managed: ReadonlyMap<string, SourceFile>;
  readonly manifest: Manifest;
  readonly seeds: ReadonlyMap<string, SourceFile>;
  readonly src: Source;
};

const inspectSeedDestinations = async (
  consumer: RepositoryRoot,
  rels: ReadonlyArray<string>,
): Promise<{
  readonly existing: ReadonlySet<string>;
  readonly missing: ReadonlyMap<string, FileState>;
}> => {
  const inspections = await Promise.all(
    rels.map(
      async (rel) => [rel, await inspectRepositoryNode(consumer, rel)] as const,
    ),
  );
  const existing = new Set<string>();
  const missing = new Map<string, FileState>();
  for (const [rel, node] of inspections) {
    if (node.info === null) {
      missing.set(rel, { contents: null, identity: null, mode: null });
    } else if (node.info.isFile() || node.info.isDirectory()) {
      existing.add(rel);
    } else {
      throw new Error(
        `${consumer.label} seed destination must be a regular file or directory: ${rel}`,
      );
    }
  }
  return { existing, missing };
};

const runInit = async ({
  consumer,
  managed,
  manifest,
  seeds,
  src,
}: RunInitOptions): Promise<void> => {
  assertDisjoint(manifest.paths, [...seeds.keys()]);
  const seedOwnership = new Set<string>([
    ...CONTRACT_V1_SEED_OWNERSHIP_BASELINE,
    ...seeds.keys(),
  ]);
  assertNoOwnershipTransitions({
    establishedSeeds: seedOwnership,
    managed: manifest.paths,
    observedSeeds: [...seeds.keys()],
    previousManaged: [],
  });
  const [managedStates, seedDestinations] = await Promise.all([
    inspectRepositoryFiles(consumer, [...managed.keys(), SYNC_LOCK_FILE]),
    inspectSeedDestinations(consumer, [...seeds.keys()]),
  ]);
  const states = new Map([...managedStates, ...seedDestinations.missing]);
  const lockBefore = requiredState(states, SYNC_LOCK_FILE);
  if (lockBefore.contents !== null) {
    throw new Error('sync-standards.lock appeared during init preflight');
  }
  const mirror = prepareMirror({
    managed,
    previous: new Map(),
    states,
  });
  const seedWrites: Array<PreparedWrite> = [...seeds]
    .filter(([rel]) => !seedDestinations.existing.has(rel))
    .map(([rel, source]) => ({
      before: requiredState(states, rel),
      contents: source.contents,
      mode: source.mode,
      rel,
    }));
  const lock = lockContents({
    upstream: manifest.upstream,
    ref: DEFAULT_SYNC_POLICY.ref,
    sha: src.sha,
    files: mirror.result.files,
    seeds: seedOwnership,
  });
  await applyRepositoryMutations({
    deletes: mirror.deletes,
    prunes: [],
    root: consumer,
    writes: [
      ...seedWrites,
      ...mirror.writes,
      {
        before: lockBefore,
        contents: lock,
        mode: lockBefore.mode,
        rel: SYNC_LOCK_FILE,
      },
    ],
  });
  for (const rel of seeds.keys()) {
    console.log(
      seedWrites.some((write) => write.rel === rel)
        ? `  seeded ${rel}`
        : `  kept ${rel} (already present)`,
    );
  }
  reportMirror(mirror.result, false);
  console.log(
    `init complete: ${mirror.result.files.size} managed file(s) at ${src.sha}`,
  );
};

type RunSyncOptions = {
  readonly manifest: Manifest;
  readonly src: Source;
  readonly consumer: RepositoryRoot;
  readonly dryRun: boolean;
  readonly lockInspection: LockInspection;
  readonly managed: ReadonlyMap<string, SourceFile>;
  readonly policyWrite: SyncPolicy | null;
  readonly policyState: FileState;
  readonly requestedRef: string;
  readonly seeds: ReadonlyMap<string, SourceFile>;
};

const runSync = async ({
  manifest,
  src,
  consumer,
  dryRun,
  lockInspection,
  managed,
  policyWrite,
  policyState,
  requestedRef,
  seeds,
}: RunSyncOptions): Promise<void> => {
  assertDisjoint(manifest.paths, [...seeds.keys()]);
  const previous = lockInspection.lock?.files ?? new Map<string, string>();
  const establishedSeeds =
    lockInspection.lock?.seeds ??
    new Set<string>(CONTRACT_V1_SEED_OWNERSHIP_BASELINE);
  assertNoOwnershipTransitions({
    establishedSeeds,
    managed: manifest.paths,
    observedSeeds: [...seeds.keys()],
    previousManaged: [...previous.keys()],
  });
  const seedOwnership = new Set([...establishedSeeds, ...seeds.keys()]);
  const targetPaths = [
    ...managed.keys(),
    ...previous.keys(),
    SYNC_LOCK_FILE,
    SYNC_POLICY_FILE,
  ];
  const states = await inspectRepositoryFiles(consumer, targetPaths);
  const currentLock = requiredState(states, SYNC_LOCK_FILE);
  if (
    !(
      currentLock.contents === lockInspection.state.contents ||
      (currentLock.contents !== null &&
        lockInspection.state.contents !== null &&
        currentLock.contents.equals(lockInspection.state.contents))
    )
  ) {
    throw new Error('sync-standards.lock changed during sync preflight');
  }
  const currentPolicy = requiredState(states, SYNC_POLICY_FILE);
  if (!fileStatesMatch(currentPolicy, policyState)) {
    throw new Error(`${SYNC_POLICY_FILE} changed during sync source selection`);
  }
  const mirror = prepareMirror({ managed, previous, states });
  const prunes = await inspectRepositoryDirectories(
    consumer,
    mirror.prunePaths,
  );
  const lock = lockContents({
    upstream: manifest.upstream,
    ref: requestedRef,
    sha: src.sha,
    files: mirror.result.files,
    seeds: seedOwnership,
  });
  const lockMetadataChanged =
    currentLock.contents === null || !currentLock.contents.equals(lock);
  const policyContents =
    policyWrite === null ? null : syncPolicyContents(policyWrite);
  const policyChanged =
    policyContents !== null && !policyState.contents?.equals(policyContents);
  reportMirror(mirror.result, dryRun, lockMetadataChanged, policyChanged);
  if (dryRun) {
    return;
  }
  if (
    mirror.writes.length === 0 &&
    mirror.deletes.length === 0 &&
    !lockMetadataChanged &&
    !policyChanged
  ) {
    console.log(
      `sync complete: ${mirror.result.files.size} managed file(s) at ${src.sha}`,
    );
    return;
  }
  const controlWrites: Array<PreparedWrite> = [
    {
      before: currentLock,
      contents: lock,
      mode: currentLock.mode,
      rel: SYNC_LOCK_FILE,
    },
  ];
  if (policyWrite !== null && policyContents !== null) {
    controlWrites.push({
      before: policyState,
      contents: policyContents,
      mode: policyState.mode,
      rel: SYNC_POLICY_FILE,
    });
  }
  await applyRepositoryMutations({
    deletes: mirror.deletes,
    prunes,
    root: consumer,
    writes: [...mirror.writes, ...controlWrites],
  });
  console.log(
    `sync complete: ${mirror.result.files.size} managed file(s) at ${src.sha}`,
  );
};

// Offline drift detection: every locked file must still match its hash. Catches
// local edits or deletions of canonical files. Does NOT detect upstream moving
// on — see the "known limitation" in the standards repository README.
const runCheck = async (
  consumer: RepositoryRoot,
  policy: SyncPolicy | null,
): Promise<boolean> => {
  const { lock } = await inspectLock(consumer);
  if (lock === null || lock.files.size === 0) {
    console.error(
      'standards: no non-empty sync-standards.lock found; run `standards init` before checking',
    );
    return false;
  }
  for (const rel of lock.files.keys()) {
    assertSafeRelativePath(rel, 'sync-standards.lock file');
  }
  for (const rel of lock.seeds) {
    assertSafeRelativePath(rel, 'sync-standards.lock seed');
  }
  assertNoReservedManagedTargets(
    [...lock.files.keys()],
    'sync-standards.lock file',
  );
  assertDisjoint([...lock.files.keys()], [...lock.seeds]);
  const lockedRef = lock.ref ?? DEFAULT_SYNC_POLICY.ref;
  const policyMatchesLock = policy === null || lockedRef === policy.ref;
  if (policy !== null && !policyMatchesLock) {
    console.error(
      `standards: sync policy requests ${policy.ref}, but sync-standards.lock records ${lockedRef}; run \`bun standards sync\``,
    );
  }
  const states = await inspectRepositoryFiles(consumer, [...lock.files.keys()]);
  const results = [...lock.files].map(([rel, hash]) => {
    const currentContents = requiredState(states, rel).contents;
    if (currentContents === null) {
      return `  missing:  ${rel}`;
    }
    const current = sha256(currentContents);
    if (current !== hash) {
      return `  modified: ${rel} (expected ${hash.slice(0, HASH_PREVIEW_LENGTH)}, found ${current.slice(0, HASH_PREVIEW_LENGTH)})`;
    }
    return null;
  });
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
  if (!policyMatchesLock) {
    return false;
  }
  console.log(`standards: ${lock.files.size} canonical file(s) match upstream`);
  return true;
};

const readTextIfPresent = async (
  root: RepositoryRoot,
  rel: string,
): Promise<string | null> => {
  const state = await inspectRepositoryFile(root, rel);
  return state.contents?.toString('utf8') ?? null;
};

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

const isDefaultSyncPolicy = (policy: SyncPolicy): boolean =>
  policy.ref === DEFAULT_SYNC_POLICY.ref &&
  policy.scheduledSync === DEFAULT_SYNC_POLICY.scheduledSync;

const inspectConsumerSyncPolicy = async (
  consumer: RepositoryRoot,
  options: ConsumerSyncPolicyInspectionOptions,
): Promise<ConsumerSyncPolicySnapshot> => {
  const contractText = await readTextIfPresent(
    consumer,
    SYNC_POLICY_CONTRACT_FILE,
  );
  const state =
    options.policyState ??
    (await inspectRepositoryFile(consumer, SYNC_POLICY_FILE));
  const storedPolicyText = state.contents?.toString('utf8') ?? null;
  const effectivePolicyText =
    options.policyText ?? storedPolicyText ?? undefined;
  const result = inspectSyncPolicy({
    packageText:
      (await readTextIfPresent(consumer, 'package.json')) ?? undefined,
    policyText: effectivePolicyText,
  });
  if (contractText === null) {
    if (options.allowMissingDefaultContract) {
      return {
        inspection: {
          ...result,
          problems: [
            ...result.problems,
            ...(result.policy !== null && !isDefaultSyncPolicy(result.policy)
              ? [
                  `${SYNC_POLICY_FILE} may be absent or contain only the exact default policy while ${SYNC_POLICY_CONTRACT_FILE} is missing; upgrade @davidvornholt/standards, run a bare sync from the repository's default branch, then pin a non-default ref`,
                ]
              : []),
          ],
        },
        state,
      };
    }
    return {
      inspection: {
        packageJson: result.packageJson,
        policy: null,
        problems: [
          `${SYNC_POLICY_CONTRACT_FILE} must exist; run \`bun standards sync\``,
          ...result.problems,
        ],
      },
      state,
    };
  }
  return { inspection: result, state };
};

const requireValidSyncPolicy = (
  inspection: SyncPolicyInspection,
): SyncPolicy => {
  if (inspection.policy === null || inspection.problems.length > 0) {
    throw new Error(inspection.problems.join('\n'));
  }
  return inspection.policy;
};

const inspectEffectiveSyncPolicy = async (
  consumer: RepositoryRoot,
  requestedRef: string | undefined,
): Promise<EffectiveSyncPolicy> => {
  const currentSnapshot = await inspectConsumerSyncPolicy(consumer, {
    allowMissingDefaultContract: true,
    policyText: undefined,
  });
  const currentPolicy = requireValidSyncPolicy(currentSnapshot.inspection);
  if (requestedRef === undefined) {
    return { policy: currentPolicy, state: currentSnapshot.state };
  }
  const proposedPolicy = { ...currentPolicy, ref: requestedRef };
  const proposedSnapshot = await inspectConsumerSyncPolicy(consumer, {
    allowMissingDefaultContract: false,
    policyState: currentSnapshot.state,
    policyText: JSON.stringify(proposedPolicy),
  });
  return {
    policy: requireValidSyncPolicy(proposedSnapshot.inspection),
    state: currentSnapshot.state,
  };
};

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

const inspectPackageJson = (
  packageJson: Record<string, unknown>,
): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  const scripts = packageJson.scripts as Record<string, unknown> | undefined;
  for (const name of ['check', 'check:fix']) {
    const script = scripts?.[name];
    if (typeof script !== 'string' || !script.includes('standards check')) {
      problems.push(`package.json script "${name}" must run standards check`);
    }
  }
  return problems;
};

const runDoctor = async (
  consumer: RepositoryRoot,
  policyInspection: SyncPolicyInspection,
): Promise<boolean> => {
  const problems: Array<string> = [...policyInspection.problems];
  const biome = await readTextIfPresent(consumer, 'biome.jsonc');
  if (biome === null || !biome.includes('"./biome.base.jsonc"')) {
    problems.push('biome.jsonc must extend "./biome.base.jsonc"');
  }

  if ((await readTextIfPresent(consumer, 'AGENTS.local.md')) === null) {
    problems.push('AGENTS.local.md must exist for project-specific guidance');
  }

  const dependabot = await readTextIfPresent(
    consumer,
    '.github/dependabot.yml',
  );
  if (dependabot === null) {
    problems.push('.github/dependabot.yml must exist');
  } else {
    problems.push(...inspectDependabot(dependabot));
  }

  if (policyInspection.packageJson !== undefined) {
    problems.push(...inspectPackageJson(policyInspection.packageJson));
  }

  // The GitHub settings seam only exists once the canonical declaration has
  // been synced in; before that there is nothing to extend.
  const canonicalSettings = await readTextIfPresent(
    consumer,
    CANONICAL_SETTINGS_FILE,
  );
  if (canonicalSettings !== null) {
    const localSettings = await readTextIfPresent(
      consumer,
      LOCAL_SETTINGS_FILE,
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
  init    Bootstrap a consumer repo: seed repo-owned files, mirror canonical files, write the lock
  sync    Mirror canonical files from upstream and rewrite the lock
  check   Verify canonical files, extension seams, and GitHub settings
  doctor  Validate extension seams only
  github  Compare (--check) or converge (--apply) live GitHub settings
  help    Show this help

Options:
  --dir <path>   Consumer directory to operate on (default: current directory)
  --from <src>   Upstream override for init/sync (GitHub repo or local path)
  --ref <ref>    Sync from refs/heads/<branch>, refs/tags/<tag>, or a full commit sha and persist that policy (remote sources only)
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
  if (ref !== undefined && command !== 'sync') {
    throw new Error('--ref is only valid with the sync command');
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

const openConsumerRoot = async (
  consumer: string,
  recover: boolean,
): Promise<RepositoryRoot> => {
  const consumerRoot = await openRepositoryRoot(
    consumer,
    'consumer repository',
  );
  if (recover) {
    await ensureGitRecoveryArtifactsExcluded(consumerRoot);
  }
  await recoverRepositoryTransactions(consumerRoot, recover);
  return consumerRoot;
};

const openSyncConsumerRoot = async (
  consumer: string,
  dryRun: boolean,
): Promise<RepositoryRoot> => {
  try {
    return await openConsumerRoot(consumer, !dryRun);
  } catch (error) {
    if (
      dryRun &&
      error instanceof Error &&
      error.message.startsWith('Pending ')
    ) {
      throw new Error(
        `${error.message}. Rerun this \`bun standards sync\` command without \`--dry-run\` to recover the pending transaction before previewing`,
        { cause: error },
      );
    }
    throw error;
  }
};

const runCheckCommand = async (consumer: string): Promise<boolean> => {
  const consumerRoot = await openConsumerRoot(consumer, false);
  const { inspection: policyInspection } = await inspectConsumerSyncPolicy(
    consumerRoot,
    {
      allowMissingDefaultContract: false,
      policyText: undefined,
    },
  );
  const driftIsClean = await runCheck(consumerRoot, policyInspection.policy);
  const integrationIsValid = await runDoctor(consumerRoot, policyInspection);
  // The GitHub gate activates with the synced declaration and then fails
  // closed: once .github/settings.json exists, an unreachable API or an
  // unreadable origin is a failure, not a skip.
  const githubIsConverged =
    (await readTextIfPresent(consumerRoot, CANONICAL_SETTINGS_FILE)) === null
      ? true
      : await runGithubCheck(consumer, consumerRoot);
  return driftIsClean && integrationIsValid && githubIsConverged;
};

const runInitCommand = async (
  consumer: string,
  from: string | undefined,
): Promise<void> => {
  const consumerRoot = await openConsumerRoot(consumer, true);
  // Refuse before cloning upstream: re-initializing skips the lock, so it
  // would silently overwrite local canonical edits and orphan files that
  // upstream deleted (they leave the lock and no future sync removes them).
  if ((await inspectLock(consumerRoot)).state.contents !== null) {
    console.error(
      'standards: already initialized (sync-standards.lock exists). Use `bun standards sync` to update.',
    );
    process.exitCode = 1;
    return;
  }
  const source = resolveSource(
    from ?? DEFAULT_UPSTREAM,
    undefined,
    from !== undefined && isExplicitLocalSource(from) ? 'explicit' : null,
  );
  try {
    const sourceRoot = await openRepositoryRoot(
      source.dir,
      'selected standards source',
    );
    const { managed, manifest, seeds } = await selectSourceTrees(
      sourceRoot,
      IGNORED_SOURCE_DIRECTORY_NAMES,
    );
    assertCompatibleSyncSource(manifest, managed, seeds);
    await runInit({
      consumer: consumerRoot,
      managed,
      manifest,
      seeds,
      src: source,
    });
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
  const consumerRoot = await openSyncConsumerRoot(consumer, dryRun);
  const lockInspection = await inspectLock(consumerRoot);
  const policySnapshot = await inspectEffectiveSyncPolicy(consumerRoot, ref);
  const legacyManifest =
    from === undefined && lockInspection.lock === null
      ? await loadSourceManifest(consumerRoot)
      : null;
  const sourceName =
    from ?? lockInspection.lock?.upstream ?? legacyManifest?.upstream;
  if (sourceName === undefined) {
    throw new Error(
      'Cannot select a standards source without --from, a valid sync-standards.lock, or a legacy sync-standards.json',
    );
  }
  const localMode = localSourceMode(from, sourceName);
  const requestedRef = ref ?? policySnapshot.policy.ref;
  const source = resolveSource(
    sourceName,
    localMode !== null && ref === undefined ? undefined : requestedRef,
    localMode,
  );
  try {
    const sourceRoot = await openRepositoryRoot(
      source.dir,
      'selected standards source',
    );
    const { managed, manifest, seeds } = await selectSourceTrees(
      sourceRoot,
      IGNORED_SOURCE_DIRECTORY_NAMES,
    );
    assertCompatibleSyncSource(manifest, managed, seeds);
    await runSync({
      manifest,
      src: source,
      consumer: consumerRoot,
      dryRun,
      lockInspection,
      managed,
      policyWrite: ref === undefined ? null : policySnapshot.policy,
      policyState: policySnapshot.state,
      requestedRef,
      seeds,
    });
  } finally {
    source.cleanup();
  }
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

  if (command === 'check') {
    if (!(await runCheckCommand(consumer))) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'github') {
    const consumerRoot = await openConsumerRoot(consumer, apply);
    const converged = apply
      ? await runGithubApply(consumer, consumerRoot)
      : await runGithubCheck(consumer, consumerRoot);
    if (!converged) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'doctor') {
    const consumerRoot = await openConsumerRoot(consumer, false);
    const { inspection: policyInspection } = await inspectConsumerSyncPolicy(
      consumerRoot,
      {
        allowMissingDefaultContract: false,
        policyText: undefined,
      },
    );
    if (!(await runDoctor(consumerRoot, policyInspection))) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'init') {
    await runInitCommand(consumer, from);
    return;
  }

  if (command === 'sync') {
    await runSyncCommand(consumer, from, ref, dryRun);
  }
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

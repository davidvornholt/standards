import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, posix } from 'node:path';
import { DEPENDABOT_FILE, retiredDependabotLayout } from './dependabot';
import { isRecord } from './github-settings-parse';
import { listManagedFiles, type ManagedEntry } from './managed-files';
import {
  AGENTS_FILE,
  AGENTS_LOCAL_HEADING,
  isSplitFile,
  sourceHead,
  splitAgents,
  withOwnPart,
} from './own-part';
import type { SyncPayload } from './sync-policy';

const MANIFEST = 'sync-standards.json';
const PAYLOADS: ReadonlyArray<SyncPayload> = ['core', 'bun'];

// What one payload adds: the AGENTS.md part, the seeds below `seedDir`, and the
// managed paths. The Bun payload builds on core, so a Bun consumer gets both.
type PayloadManifest = {
  readonly agents: string;
  readonly seeds: ReadonlyArray<string>;
  readonly paths: ReadonlyArray<string>;
};

export type Manifest = {
  readonly upstream: string;
  readonly seedDir: string;
  readonly payloads: Readonly<Record<SyncPayload, PayloadManifest>>;
};

export const assertSafeRelativePath = (path: string, label: string): void => {
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

// `.` is allowed only as a seed, where it seeds the whole seed directory.
const pathList = (
  value: unknown,
  label: string,
  allowRoot = false,
): ReadonlyArray<string> => {
  if (!(Array.isArray(value) && value.every((p) => typeof p === 'string'))) {
    throw new Error(`${MANIFEST} requires a string array ${label}`);
  }
  for (const path of value) {
    if (!(allowRoot && path === '.')) {
      assertSafeRelativePath(path, `${MANIFEST} ${label} entry`);
    }
  }
  return value;
};

const parsePayload = (raw: unknown, name: SyncPayload): PayloadManifest => {
  if (!isRecord(raw) || typeof raw.agents !== 'string') {
    throw new Error(
      `${MANIFEST} payload "${name}" must be an object with a string "agents"`,
    );
  }
  assertSafeRelativePath(raw.agents, `${MANIFEST} payload "${name}" agents`);
  const paths = pathList(raw.paths, `"payloads.${name}.paths"`);
  if (paths.includes(AGENTS_FILE)) {
    throw new Error(
      `${MANIFEST} payload "${name}" must not manage ${AGENTS_FILE}; sync generates it from the payload's "agents" parts`,
    );
  }
  return {
    agents: raw.agents,
    seeds: pathList(raw.seeds, `"payloads.${name}.seeds"`, true),
    paths,
  };
};

const assertUnique = (values: ReadonlyArray<string>, label: string): void => {
  if (new Set(values).size !== values.length) {
    throw new Error(`${MANIFEST} ${label} must be unique across payloads`);
  }
};

export const parseManifest = (raw: unknown): Manifest => {
  if (!isRecord(raw)) {
    throw new Error(`${MANIFEST} must be a JSON object`);
  }
  if (typeof raw.upstream !== 'string' || typeof raw.seedDir !== 'string') {
    throw new Error(`${MANIFEST} requires string "upstream" and "seedDir"`);
  }
  assertSafeRelativePath(raw.seedDir, `${MANIFEST} "seedDir"`);
  const { payloads } = raw;
  if (
    !isRecord(payloads) ||
    Object.keys(payloads).length !== PAYLOADS.length ||
    !PAYLOADS.every((name) => Object.hasOwn(payloads, name))
  ) {
    throw new Error(
      `${MANIFEST} requires "payloads" with exactly the keys ${PAYLOADS.join(' and ')}`,
    );
  }
  const core = parsePayload(payloads.core, 'core');
  const bun = parsePayload(payloads.bun, 'bun');
  assertUnique([...core.paths, ...bun.paths], 'managed paths');
  assertUnique([...core.seeds, ...bun.seeds], 'seeds');
  return {
    upstream: raw.upstream,
    seedDir: raw.seedDir,
    payloads: { core, bun },
  };
};

const readManifestJson = async (path: string): Promise<unknown> => {
  if (!existsSync(path)) {
    throw new Error(`Manifest not found: ${path}`);
  }
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
};

export const loadManifest = async (path: string): Promise<Manifest> =>
  parseManifest(await readManifestJson(path));

// A consumer's own manifest is the one the previous sync mirrored in, possibly
// in an older shape. Only its upstream decides anything before the source's
// manifest is read, so a shape change never locks a consumer out of syncing.
export const readManifestUpstream = async (path: string): Promise<string> => {
  const raw = await readManifestJson(path);
  if (!isRecord(raw) || typeof raw.upstream !== 'string') {
    throw new Error(`${MANIFEST} requires a string "upstream"`);
  }
  return raw.upstream;
};

const selectedParts = (
  manifest: Manifest,
  payload: SyncPayload,
): ReadonlyArray<PayloadManifest> =>
  payload === 'core'
    ? [manifest.payloads.core]
    : [manifest.payloads.core, manifest.payloads.bun];

// One self-contained file rather than `@` imports: Codex doesn't expand them,
// and an import of a part that doesn't apply would dangle.
export const composeAgents = async (
  srcDir: string,
  manifest: Manifest,
  payload: SyncPayload,
): Promise<string> => {
  const parts = await Promise.all(
    selectedParts(manifest, payload).map(async (part) =>
      (await readFile(join(srcDir, part.agents), 'utf8')).trim(),
    ),
  );
  if (parts.some((part) => splitAgents(part) !== null)) {
    throw new Error(
      `An AGENTS.md part must not contain the line "${AGENTS_LOCAL_HEADING}"`,
    );
  }
  return `${['# AGENTS.md', ...parts, AGENTS_LOCAL_HEADING].join('\n\n')}\n`;
};

export type PayloadPlan = {
  readonly seeds: ReadonlyMap<string, ManagedEntry>;
  readonly upstream: ReadonlyMap<string, ManagedEntry>;
};

// Lists what init and sync mirror for one payload. Each split file keeps the
// consumer's own part and is staged in a temporary directory that lives only as
// long as `use`.
export const withPayloadPlan = async <T>(
  {
    manifest,
    srcDir,
    payload,
    consumer,
  }: {
    readonly manifest: Manifest;
    readonly srcDir: string;
    readonly payload: SyncPayload;
    readonly consumer: string;
  },
  use: (plan: PayloadPlan) => Promise<T>,
): Promise<T> => {
  const parts = selectedParts(manifest, payload);
  const paths = parts.flatMap((part) => part.paths);
  const seeds = await listManagedFiles(
    join(srcDir, manifest.seedDir),
    parts.flatMap((part) => part.seeds),
  );
  assertDisjoint([...paths, AGENTS_FILE], [...seeds.keys()]);
  const retired = paths.includes(DEPENDABOT_FILE)
    ? await retiredDependabotLayout(consumer)
    : null;
  if (retired !== null) {
    throw new Error(retired);
  }
  const listed = await listManagedFiles(srcDir, paths);
  const heads: ReadonlyArray<readonly [string, string]> = [
    [AGENTS_FILE, await composeAgents(srcDir, manifest, payload)],
    ...(await Promise.all(
      paths
        .filter(isSplitFile)
        .map(
          async (rel) => [rel, await sourceHead(rel, listed.get(rel))] as const,
        ),
    )),
  ];
  const staging = await mkdtemp(join(tmpdir(), 'standards-split-'));
  try {
    const upstream = new Map(listed);
    await Promise.all(
      heads.map(async ([rel, head]) => {
        const staged = join(staging, rel);
        await mkdir(dirname(staged), { recursive: true });
        await writeFile(staged, await withOwnPart(rel, head, consumer));
        upstream.set(rel, { kind: 'file', absolutePath: staged });
      }),
    );
    return await use({ seeds, upstream });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
};

// The standards source repository's own AGENTS.md is the Bun composition of its
// parts, kept in step by its root gate.
export const readSourceAgents = async (
  dir: string,
): Promise<{ readonly composed: string; readonly current: string | null }> => {
  const manifest = await loadManifest(join(dir, MANIFEST));
  const path = join(dir, AGENTS_FILE);
  return {
    composed: await composeAgents(dir, manifest, 'bun'),
    current: existsSync(path) ? await readFile(path, 'utf8') : null,
  };
};

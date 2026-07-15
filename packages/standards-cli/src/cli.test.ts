// Black-box integration tests: drive the sync CLI as a subprocess against
// throwaway temp fixtures and assert its documented status/stdout/stderr.

import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';
import { declaredRuleset } from './github-ruleset-test-fixture';
import { transactionArtifacts } from './sync-mutations-test-helpers';
import { DEFAULT_SYNC_POLICY, SYNC_POLICY_FILE } from './sync-policy';
import {
  TRANSACTION_DIRECTORY,
  TRANSACTION_JOURNAL,
  TRANSACTION_OWNER,
  TRANSACTION_RESERVATION,
} from './sync-transaction-types';

const ENGINE = join(import.meta.dir, 'cli.ts');
const LEGACY_ENGINE = join(
  import.meta.dir,
  '../node_modules/standards-v04/src/cli.ts',
);
const WORKFLOW = join(
  import.meta.dir,
  '../../../.github/workflows/standards-sync.yml',
);
const ROOT_MANIFEST = join(import.meta.dir, '../../../sync-standards.json');
const POLICY_SEED = join(
  import.meta.dir,
  '../../../template',
  SYNC_POLICY_FILE,
);
const TEMPLATE_ROOT = join(import.meta.dir, '../../../template');
const SYNC_POLICY_CONTROLLER_PATH = '.github/actions/standards-sync-preflight';
const SYNC_POLICY_CONTROLLER_FILES = ['action.yml', 'index.mjs'] as const;
const SYNC_POLICY_CONTRACT_PATH = `${SYNC_POLICY_CONTROLLER_PATH}/index.mjs`;
const LEGACY_ORPHAN_POLICY_PATH = 'packages/standards-cli/src/sync-policy.ts';
const SYNC_POLICY_CONTROLLER_SOURCE = join(
  import.meta.dir,
  '../../../',
  SYNC_POLICY_CONTROLLER_PATH,
);
const STD_PATHS: ReadonlyArray<string> = [
  'sync-standards.json',
  'managed',
  SYNC_POLICY_CONTROLLER_PATH,
];
const PROTOTYPE_NAMED_FILES = ['__proto__', 'constructor', 'toString'] as const;
const PROTOTYPE_NAMED_FILE_SET: ReadonlySet<string> = new Set(
  PROTOTYPE_NAMED_FILES,
);
const SYNC_POLICY_CONTRACT_VERSION = 1;
const BARE_SYNC_STEP = /^\s+run: bun standards sync$/mu;
const FILE_TYPE_MODE_BASE = 0o1000;
const EXECUTABLE_MODE = 0o755;
const FETCH_WAIT_ATTEMPTS = 500;
const FETCH_WAIT_INTERVAL_MS = 10;
const COMMIT_SHA_LENGTH = 40;
const SHA256_LENGTH = 64;
const TRANSACTION_ID = '11111111-1111-4111-8111-111111111111';
const RESERVED_ATOMIC_TAIL = `${TRANSACTION_RESERVATION}.${TRANSACTION_ID}.tmp`;
const ATOMIC_TAIL_LOOKALIKE = `${TRANSACTION_RESERVATION}.11111111-1111-3111-8111-111111111111.tmp`;

type RunResult = { stdout: string; stderr: string; status: number };
type Lock = {
  upstream: string;
  ref?: string;
  sha: string;
  files: Record<string, string>;
  seeds: Array<string>;
};
type RunOptions = {
  readonly engine?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly preload?: string;
};

type PausedRun = {
  readonly args: ReadonlyArray<string>;
  readonly consumer: string;
};

const tmps: Array<string> = [];

const mkTmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(dir);
  return dir;
};
const write = (root: string, rel: string, content: string): void => {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
};
const writePrivate = (root: string, rel: string, content: string): void => {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, { mode: 0o600 });
};
const read = (root: string, rel: string): string =>
  readFileSync(join(root, rel), 'utf8');
const readLock = (root: string): Lock =>
  JSON.parse(read(root, 'sync-standards.lock')) as Lock;
const listRelativeFiles = (
  root: string,
  directory = '',
): ReadonlyArray<string> =>
  readdirSync(join(root, directory), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = directory === '' ? entry.name : `${directory}/${entry.name}`;
      return entry.isDirectory() ? listRelativeFiles(root, path) : [path];
    },
  );
const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
const writePendingTransaction = (consumer: string): void => {
  const id = '00000000-0000-4000-8000-000000000000';
  const root = lstatSync(consumer);
  const lockContents = read(consumer, 'sync-standards.lock');
  const lock = lstatSync(join(consumer, 'sync-standards.lock'));
  const lockState = {
    dev: String(lock.dev),
    hash: sha256(lockContents),
    ino: String(lock.ino),
    mode: lock.mode % FILE_TYPE_MODE_BASE,
  };
  writePrivate(
    consumer,
    `${TRANSACTION_DIRECTORY}/${TRANSACTION_JOURNAL}`,
    `${JSON.stringify({
      createdParents: [],
      id,
      lockRel: 'sync-standards.lock',
      operations: [
        {
          backup: 'old-0',
          before: lockState,
          desired: { hash: lockState.hash, mode: lockState.mode },
          kind: 'write',
          rel: 'sync-standards.lock',
          stage: 'new-0',
        },
      ],
      ownerPid: 2_147_483_647,
      root: { dev: String(root.dev), ino: String(root.ino) },
      version: 1,
    })}\n`,
  );
  const transaction = lstatSync(join(consumer, TRANSACTION_DIRECTORY));
  writePrivate(
    consumer,
    `${TRANSACTION_DIRECTORY}/${TRANSACTION_OWNER}`,
    `${JSON.stringify({
      id,
      root: { dev: String(root.dev), ino: String(root.ino) },
      transaction: {
        dev: String(transaction.dev),
        ino: String(transaction.ino),
      },
      version: 1,
    })}\n`,
  );
};
const githubRequestTrap = (
  consumer: string,
): { readonly marker: string; readonly preload: string } => {
  const marker = join(consumer, 'github-request-marker');
  const preload = join(consumer, 'github-request-trap.ts');
  writeFileSync(
    preload,
    [
      "import { appendFileSync } from 'node:fs';",
      `const marker = ${JSON.stringify(marker)};`,
      'globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {',
      "  appendFileSync(marker, 'request\\n');",
      "  return Promise.reject(new Error('unexpected GitHub API request'));",
      '}) as typeof fetch;',
      '',
    ].join('\n'),
  );
  return { marker, preload };
};
const setStandardsVersion = (root: string, version: string): void => {
  const packageJson = JSON.parse(read(root, 'package.json')) as {
    devDependencies: Record<string, string>;
  };
  packageJson.devDependencies['@davidvornholt/standards'] = version;
  write(root, 'package.json', JSON.stringify(packageJson));
};

const run = (
  cwd: string,
  args: ReadonlyArray<string>,
  options: RunOptions = {},
): RunResult => {
  try {
    const preload =
      options.preload === undefined ? [] : ['--preload', options.preload];
    const stdout = execFileSync(
      'bun',
      [...preload, options.engine ?? ENGINE, ...args],
      {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, ...options.env },
      },
    );
    return { stdout, stderr: '', status: 0 };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      status: e.status ?? 1,
    };
  }
};

const waitForFile = async (path: string): Promise<void> => {
  for (let attempt = 0; attempt < FETCH_WAIT_ATTEMPTS; attempt += 1) {
    if (existsSync(path)) {
      return;
    }
    // biome-ignore lint/performance/noAwaitInLoops: This polls a marker created by a deliberately paused child process.
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, FETCH_WAIT_INTERVAL_MS),
    );
  }
  throw new Error(`timed out waiting for ${path}`);
};

const pausedGitFetchRun = async ({
  args,
  consumer,
}: PausedRun): Promise<RunResult> => {
  const control = mkTmp('sync-git-pause-');
  const bin = join(control, 'bin');
  const marker = join(control, 'fetch-started');
  const release = join(control, 'fetch-release');
  mkdirSync(bin);
  const wrapper = join(bin, 'git');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(
    wrapper,
    `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = fetch ]; then\n    : > ${JSON.stringify(marker)}\n    while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.01; done\n  fi\ndone\nexec ${JSON.stringify(realGit)} "$@"\n`,
  );
  chmodSync(wrapper, EXECUTABLE_MODE);
  const child = spawn('bun', [ENGINE, ...args], {
    cwd: consumer,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
  });
  let stderr = '';
  let stdout = '';
  child.stderr.setEncoding('utf8');
  child.stdout.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  const exited = new Promise<number>((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', (code) => resolveExit(code ?? 1));
  });
  await waitForFile(marker);
  write(
    consumer,
    SYNC_POLICY_FILE,
    JSON.stringify({ ref: DEFAULT_SYNC_POLICY.ref, scheduledSync: false }),
  );
  writeFileSync(release, 'continue\n');
  const status = await exited;
  return { status, stderr, stdout };
};

// A fake upstream: its own manifest, a `template/` seed dir, two managed files.
const buildUpstream = (paths: ReadonlyArray<string> = STD_PATHS): string => {
  const up = mkTmp('sync-up-');
  write(
    up,
    'sync-standards.json',
    JSON.stringify({
      upstream: up,
      seedDir: 'template',
      syncPolicyContractVersion: SYNC_POLICY_CONTRACT_VERSION,
      paths,
    }),
  );
  write(up, 'template/seed.txt', 'seed original\n');
  write(
    up,
    `template/${SYNC_POLICY_FILE}`,
    `${JSON.stringify(DEFAULT_SYNC_POLICY, null, 2)}\n`,
  );
  write(up, 'template/AGENTS.local.md', '# Local\n');
  write(up, 'template/biome.jsonc', '{"extends":["./biome.base.jsonc"]}\n');
  write(
    up,
    'template/.github/dependabot.yml',
    [
      'version: 2',
      'updates:',
      '  - package-ecosystem: bun',
      '    directory: /',
      '    schedule:',
      '      interval: weekly',
      '  - package-ecosystem: github-actions',
      '    directory: /',
      '    schedule:',
      '      interval: weekly',
      '',
    ].join('\n'),
  );
  write(
    up,
    'template/package.json',
    JSON.stringify({
      scripts: {
        check: 'standards check',
        'check:fix': 'standards check',
      },
      devDependencies: { '@davidvornholt/standards': '0.5.0' },
    }),
  );
  write(up, 'managed/a.txt', 'alpha\n');
  write(up, 'managed/b.txt', 'beta\n');
  write(up, 'managed/standards-sync.yml', 'run: bun standards sync\n');
  for (const file of SYNC_POLICY_CONTROLLER_FILES) {
    write(
      up,
      `${SYNC_POLICY_CONTROLLER_PATH}/${file}`,
      readFileSync(join(SYNC_POLICY_CONTROLLER_SOURCE, file), 'utf8'),
    );
  }
  return up;
};
const addPrototypeNamedFiles = (up: string): void => {
  const manifest = JSON.parse(read(up, 'sync-standards.json')) as {
    paths: Array<string>;
  };
  manifest.paths.push(...PROTOTYPE_NAMED_FILES);
  write(up, 'sync-standards.json', JSON.stringify(manifest));
  for (const file of PROTOTYPE_NAMED_FILES) {
    write(up, file, `${file}\n`);
  }
};
const removePrototypeNamedFiles = (up: string): void => {
  const manifest = JSON.parse(read(up, 'sync-standards.json')) as {
    paths: Array<string>;
  };
  manifest.paths = manifest.paths.filter(
    (path) => !PROTOTYPE_NAMED_FILE_SET.has(path),
  );
  write(up, 'sync-standards.json', JSON.stringify(manifest));
  for (const file of PROTOTYPE_NAMED_FILES) {
    rmSync(join(up, file));
  }
};
const prototypeNamedLockEntries = (consumer: string) => {
  const { files } = readLock(consumer);
  return PROTOTYPE_NAMED_FILES.map((file) => {
    const own = Object.hasOwn(files, file);
    return { file, hash: own ? files[file] : undefined, own };
  });
};
const expectedPrototypeNamedLockEntries = (present: boolean) =>
  PROTOTYPE_NAMED_FILES.map((file) => ({
    file,
    hash: present ? sha256(`${file}\n`) : undefined,
    own: present,
  }));
const initConsumer = (up: string): { consumer: string; result: RunResult } => {
  const consumer = mkTmp('sync-cons-');
  const result = run(consumer, ['init', '--from', up, '--dir', consumer]);
  return { consumer, result };
};
const removeSyncPolicyController = (consumer: string): void => {
  rmSync(join(consumer, SYNC_POLICY_CONTROLLER_PATH), { recursive: true });
};
const sync = (
  up: string,
  consumer: string,
  extra: ReadonlyArray<string> = [],
): RunResult =>
  run(consumer, ['sync', ...extra, '--from', up, '--dir', consumer]);

const git = (dir: string, args: ReadonlyArray<string>): string =>
  execFileSync(
    'git',
    [
      '-C',
      dir,
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { encoding: 'utf8' },
  ).trim();
const retainedRecoveryArtifacts = (root: string): ReadonlyArray<string> =>
  readdirSync(root)
    .filter((name) => name.startsWith('.standards-removal-'))
    .sort();

// A git-backed upstream with a real pre-contract snapshot, then a compatible
// tagged snapshot, then main. The compatibility marker and controller do not
// exist in the historical v0.4.0 tree.
const buildGitUpstream = (): {
  up: string;
  url: string;
  taggedSha: string;
} => {
  const up = buildUpstream();
  git(up, ['init', '--quiet', '-b', 'main']);
  const controllerFiles = Object.fromEntries(
    SYNC_POLICY_CONTROLLER_FILES.map((file) => [
      file,
      read(up, `${SYNC_POLICY_CONTROLLER_PATH}/${file}`),
    ]),
  );
  write(
    up,
    'sync-standards.json',
    JSON.stringify({
      upstream: `file://${up}`,
      seedDir: 'template',
      paths: ['sync-standards.json', 'managed'],
    }),
  );
  rmSync(join(up, 'template', SYNC_POLICY_FILE));
  rmSync(join(up, '.github'), { recursive: true });
  git(up, ['add', '-A']);
  git(up, ['commit', '--quiet', '-m', 'v0.4.0']);
  git(up, ['tag', 'v0.4.0']);

  write(
    up,
    'sync-standards.json',
    JSON.stringify({
      upstream: `file://${up}`,
      seedDir: 'template',
      syncPolicyContractVersion: SYNC_POLICY_CONTRACT_VERSION,
      paths: STD_PATHS,
    }),
  );
  for (const [file, content] of Object.entries(controllerFiles)) {
    write(up, `${SYNC_POLICY_CONTROLLER_PATH}/${file}`, content);
  }
  git(up, ['add', '-A']);
  git(up, ['commit', '--quiet', '-m', 'v1']);
  git(up, ['tag', 'v1']);
  git(up, ['tag', 'collision']);
  const taggedSha = git(up, ['rev-parse', 'HEAD']);
  git(up, ['tag', '--annotate', 'annotated', '--message', 'annotated']);
  write(
    up,
    `template/${SYNC_POLICY_FILE}`,
    `${JSON.stringify(DEFAULT_SYNC_POLICY, null, 2)}\n`,
  );
  write(up, 'managed/a.txt', 'alpha v2\n');
  git(up, ['add', '-A']);
  git(up, ['commit', '--quiet', '-m', 'v2']);
  git(up, ['branch', 'stable', taggedSha]);
  git(up, ['branch', 'collision']);
  return { up, url: `file://${up}`, taggedSha };
};

afterEach(() => {
  while (tmps.length > 0) {
    const dir = tmps.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('init', () => {
  it('seeds a template-only file, mirrors managed files, writes lock', () => {
    const { consumer, result } = initConsumer(buildUpstream());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('seeded seed.txt');
    expect(result.stdout).toContain('init complete:');
    expect(read(consumer, 'seed.txt')).toBe('seed original\n');
    expect(read(consumer, '.github/dependabot.yml')).toContain(
      'package-ecosystem: bun',
    );
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(read(consumer, SYNC_POLICY_FILE)).toContain(
      JSON.stringify(DEFAULT_SYNC_POLICY.ref),
    );
    expect(readLock(consumer).ref).toBe(DEFAULT_SYNC_POLICY.ref);
    expect(readLock(consumer).files['managed/a.txt']).toBeDefined();
    expect(readLock(consumer).seeds).toEqual(
      [...listRelativeFiles(TEMPLATE_ROOT), 'seed.txt'].sort((a, b) =>
        a.localeCompare(b),
      ),
    );
    expect(existsSync(join(consumer, 'packages/standards-cli'))).toBe(false);
  });

  it('does not let an inherited GIT_DIR redirect remote-source Git commands', () => {
    const upstream = buildGitUpstream();
    const victim = mkTmp('sync-git-environment-victim-');
    write(victim, 'victim.txt', 'victim unchanged\n');
    git(victim, ['init', '--quiet', '-b', 'main']);
    git(victim, ['add', 'victim.txt']);
    git(victim, ['commit', '--quiet', '-m', 'victim']);
    const victimGit = join(victim, '.git');
    const before = {
      config: readFileSync(join(victimGit, 'config')),
      entries: readdirSync(victimGit).sort(),
      head: readFileSync(join(victimGit, 'HEAD')),
      index: readFileSync(join(victimGit, 'index')),
      status: git(victim, ['status', '--porcelain']),
    };
    const consumer = mkTmp('sync-git-environment-consumer-');

    const result = run(
      consumer,
      ['init', '--from', upstream.url, '--dir', consumer],
      { env: { GIT_DIR: victimGit } },
    );

    expect(result.status).toBe(0);
    expect(readLock(consumer).sha).toHaveLength(COMMIT_SHA_LENGTH);
    expect(readFileSync(join(victimGit, 'config'))).toEqual(before.config);
    expect(readFileSync(join(victimGit, 'HEAD'))).toEqual(before.head);
    expect(readFileSync(join(victimGit, 'index'))).toEqual(before.index);
    expect(readdirSync(victimGit).sort()).toEqual(before.entries);
    expect(git(victim, ['status', '--porcelain'])).toBe(before.status);
    expect(read(victim, 'victim.txt')).toBe('victim unchanged\n');
  });

  it('never clobbers a pre-existing seed destination', () => {
    const up = buildUpstream();
    const consumer = mkTmp('sync-cons-');
    write(consumer, 'seed.txt', 'mine\n');
    const result = run(consumer, ['init', '--from', up, '--dir', consumer]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('kept seed.txt (already present)');
    expect(read(consumer, 'seed.txt')).toBe('mine\n');
  });

  it('keeps a pre-existing real directory at a seed destination', () => {
    const up = buildUpstream();
    const consumer = mkTmp('sync-cons-');
    mkdirSync(join(consumer, 'seed.txt'));

    const result = run(consumer, ['init', '--from', up, '--dir', consumer]);

    expect(result.status).toBe(0);
    expect(lstatSync(join(consumer, 'seed.txt')).isDirectory()).toBe(true);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(readLock(consumer).files['managed/a.txt']).toBeDefined();
  });

  it('refuses to re-initialize when a lock already exists', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    write(consumer, 'managed/a.txt', 'local edit\n');
    const again = run(consumer, ['init', '--from', up, '--dir', consumer]);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('already initialized');
    expect(read(consumer, 'managed/a.txt')).toBe('local edit\n');
  });

  it('errors when a managed path overlaps a seed target', () => {
    const { consumer, result } = initConsumer(
      buildUpstream([...STD_PATHS, 'seed.txt']),
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('overlaps seed path');
    expect(existsSync(join(consumer, 'sync-standards.lock'))).toBe(false);
  });
});

describe('sync source authority', () => {
  it('restores a missing managed manifest from the locked upstream', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    rmSync(join(consumer, 'sync-standards.json'));
    write(up, 'managed/a.txt', 'locked upstream\n');

    const result = run(consumer, ['sync', '--dir', consumer]);

    expect(result.status).toBe(0);
    expect(read(consumer, 'sync-standards.json')).toBe(
      read(up, 'sync-standards.json'),
    );
    expect(read(consumer, 'managed/a.txt')).toBe('locked upstream\n');
  });

  it('restores a malformed managed manifest from the locked upstream', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    write(consumer, 'sync-standards.json', '{ malformed');
    write(up, 'managed/a.txt', 'locked upstream\n');

    const result = run(consumer, ['sync', '--dir', consumer]);

    expect(result.status).toBe(0);
    expect(read(consumer, 'sync-standards.json')).toBe(
      read(up, 'sync-standards.json'),
    );
    expect(read(consumer, 'managed/a.txt')).toBe('locked upstream\n');
  });

  it('does not let a modified managed manifest redirect bare sync', () => {
    const lockedUpstream = buildUpstream();
    const redirect = buildUpstream();
    const { consumer } = initConsumer(lockedUpstream);
    const consumerManifest = JSON.parse(
      read(consumer, 'sync-standards.json'),
    ) as Record<string, unknown>;
    write(
      consumer,
      'sync-standards.json',
      JSON.stringify({ ...consumerManifest, upstream: redirect }),
    );
    write(lockedUpstream, 'managed/a.txt', 'locked upstream\n');
    write(redirect, 'managed/a.txt', 'redirected upstream\n');

    const result = run(consumer, ['sync', '--dir', consumer]);

    expect(result.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('locked upstream\n');
    expect(readLock(consumer).upstream).toBe(lockedUpstream);
  });
});

describe('sync source selection', () => {
  it('keeps policy ref selection when the lock supplies source authority', () => {
    const { up, taggedSha } = buildGitUpstream();
    const redirect = buildUpstream();
    const { consumer } = initConsumer(up);
    const consumerManifest = JSON.parse(
      read(consumer, 'sync-standards.json'),
    ) as Record<string, unknown>;
    write(
      consumer,
      'sync-standards.json',
      JSON.stringify({ ...consumerManifest, upstream: redirect }),
    );
    write(
      consumer,
      SYNC_POLICY_FILE,
      JSON.stringify({ ref: 'refs/tags/v1', scheduledSync: true }),
    );
    write(redirect, 'managed/a.txt', 'redirected upstream\n');

    const result = run(consumer, ['sync', '--dir', consumer]);

    expect(result.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(readLock(consumer).ref).toBe('refs/tags/v1');
    expect(readLock(consumer).sha).toBe(taggedSha);
  });

  it('uses an explicit --from as the source override', () => {
    const lockedUpstream = buildUpstream();
    const override = buildUpstream();
    const { consumer } = initConsumer(lockedUpstream);
    write(lockedUpstream, 'managed/a.txt', 'locked upstream\n');
    write(override, 'managed/a.txt', 'explicit override\n');

    const result = sync(override, consumer);

    expect(result.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('explicit override\n');
    expect(readLock(consumer).upstream).toBe(override);
  });

  it('rejects an invalid lock before consulting the managed manifest', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    const invalidLock = { ...readLock(consumer), upstream: '' };
    write(
      consumer,
      'sync-standards.lock',
      `${JSON.stringify(invalidLock, null, 2)}\n`,
    );
    write(consumer, 'sync-standards.json', '{ malformed');
    const filesBefore = listRelativeFiles(consumer);
    const contentsBefore = new Map(
      filesBefore.map((rel) => [rel, read(consumer, rel)]),
    );

    const result = run(consumer, ['sync', '--dir', consumer]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'sync-standards.lock "upstream" must be a non-empty string',
    );
    expect(result.stderr).not.toContain('Unexpected identifier');
    expect(listRelativeFiles(consumer)).toEqual(filesBefore);
    for (const [rel, contents] of contentsBefore) {
      expect(read(consumer, rel)).toBe(contents);
    }
  });

  it('keeps the managed-manifest fallback for a lockless legacy consumer', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    rmSync(join(consumer, 'sync-standards.lock'));
    write(up, 'managed/a.txt', 'legacy update\n');

    const result = run(consumer, ['sync', '--dir', consumer]);

    expect(result.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('legacy update\n');
    expect(readLock(consumer).upstream).toBe(up);
  });
});

describe('check', () => {
  it('passes right after init', () => {
    const { consumer } = initConsumer(buildUpstream());
    const check = run(consumer, ['check', '--dir', consumer]);
    expect(check.status).toBe(0);
    expect(check.stdout).toContain('canonical file(s) match upstream');
  });

  it('fails and reports modified when a managed file is edited', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, 'managed/a.txt', 'tampered\n');
    const check = run(consumer, ['check', '--dir', consumer]);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('canonical file(s) drifted from upstream');
    expect(check.stderr).toContain('modified: managed/a.txt');
  });

  it('fails and reports missing when a managed file is deleted', () => {
    const { consumer } = initConsumer(buildUpstream());
    rmSync(join(consumer, 'managed/a.txt'));
    const check = run(consumer, ['check', '--dir', consumer]);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('missing:  managed/a.txt');
  });

  it('fails closed when the lock is missing', () => {
    const consumer = mkTmp('sync-cons-');
    const check = run(consumer, ['check', '--dir', consumer]);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('no non-empty sync-standards.lock found');
  });

  it('accepts an old lock without ref only at the default policy', () => {
    const { consumer } = initConsumer(buildUpstream());
    const { ref: _ref, ...oldLock } = readLock(consumer);
    write(
      consumer,
      'sync-standards.lock',
      `${JSON.stringify(oldLock, null, 2)}\n`,
    );
    rmSync(join(consumer, SYNC_POLICY_FILE));

    expect(run(consumer, ['check', '--dir', consumer]).status).toBe(0);

    write(
      consumer,
      SYNC_POLICY_FILE,
      JSON.stringify({ ref: 'refs/tags/v1', scheduledSync: true }),
    );
    const pinnedCheck = run(consumer, ['check', '--dir', consumer]);
    expect(pinnedCheck.status).toBe(1);
    expect(pinnedCheck.stderr).toContain(
      `policy requests refs/tags/v1, but sync-standards.lock records ${DEFAULT_SYNC_POLICY.ref}`,
    );
  });

  it('rejects policy and lock disagreement', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(
      consumer,
      SYNC_POLICY_FILE,
      JSON.stringify({ ref: 'refs/heads/stable', scheduledSync: true }),
    );

    const check = run(consumer, ['check', '--dir', consumer]);

    expect(check.status).toBe(1);
    expect(check.stderr).toContain(
      `policy requests refs/heads/stable, but sync-standards.lock records ${DEFAULT_SYNC_POLICY.ref}`,
    );
  });
});

describe('lock seed ownership schema', () => {
  it('rejects a non-array seed ownership field', () => {
    const { consumer } = initConsumer(buildUpstream());
    const malformedLock = { ...readLock(consumer), seeds: 'README.md' };
    write(
      consumer,
      'sync-standards.lock',
      `${JSON.stringify(malformedLock, null, 2)}\n`,
    );

    const check = run(consumer, ['check', '--dir', consumer]);

    expect(check.status).toBe(1);
    expect(check.stderr).toContain(
      'sync-standards.lock "seeds" must be a string array',
    );
  });

  it.each([
    'check',
    'sync',
  ] as const)('rejects an explicit null seed field during %s without mutation', (command) => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    const malformedLock = { ...readLock(consumer), seeds: null };
    write(
      consumer,
      'sync-standards.lock',
      `${JSON.stringify(malformedLock, null, 2)}\n`,
    );
    const lockBefore = read(consumer, 'sync-standards.lock');
    const managedBefore = read(consumer, 'managed/a.txt');

    const result =
      command === 'check'
        ? run(consumer, ['check', '--dir', consumer])
        : sync(up, consumer);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'sync-standards.lock "seeds" must be a string array',
    );
    expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
    expect(read(consumer, 'managed/a.txt')).toBe(managedBefore);
  });
});

type InvalidLock = {
  readonly expected: string;
  readonly label: string;
  readonly value: (lock: Lock) => unknown;
};

const INVALID_LOCKS: Array<InvalidLock> = [
  {
    expected: 'must be a JSON object',
    label: 'null root',
    value: () => null,
  },
  {
    expected: 'must be a JSON object',
    label: 'array root',
    value: () => [],
  },
  {
    expected: 'must be a JSON object',
    label: 'primitive root',
    value: () => 'lock',
  },
  {
    expected: 'has unknown key "extra"',
    label: 'unknown root field',
    value: (lock) => ({ ...lock, extra: true }),
  },
  {
    expected: '"upstream" must be a non-empty string',
    label: 'missing upstream',
    value: ({ upstream: _upstream, ...lock }) => lock,
  },
  {
    expected: '"upstream" must be a non-empty string',
    label: 'null upstream',
    value: (lock) => ({ ...lock, upstream: null }),
  },
  {
    expected: '"upstream" must be a non-empty string',
    label: 'empty upstream',
    value: (lock) => ({ ...lock, upstream: '' }),
  },
  {
    expected: '"ref" must be a string',
    label: 'null ref',
    value: (lock) => ({ ...lock, ref: null }),
  },
  {
    expected: 'Unsupported ref "main"',
    label: 'unqualified ref',
    value: (lock) => ({ ...lock, ref: 'main' }),
  },
  {
    expected: '"sha" must be "local" or a lowercase full Git commit ID',
    label: 'null source sha',
    value: (lock) => ({ ...lock, sha: null }),
  },
  {
    expected: '"sha" must be "local" or a lowercase full Git commit ID',
    label: 'uppercase source sha',
    value: (lock) => ({ ...lock, sha: 'A'.repeat(COMMIT_SHA_LENGTH) }),
  },
  {
    expected: '"sha" must be "local" or a lowercase full Git commit ID',
    label: 'short source sha',
    value: (lock) => ({
      ...lock,
      sha: 'a'.repeat(COMMIT_SHA_LENGTH - 1),
    }),
  },
  {
    expected: '"files" must be a JSON object',
    label: 'missing files',
    value: ({ files: _files, ...lock }) => lock,
  },
  {
    expected: '"files" must be a JSON object',
    label: 'null files',
    value: (lock) => ({ ...lock, files: null }),
  },
  {
    expected: '"files" must be a JSON object',
    label: 'array files',
    value: (lock) => ({ ...lock, files: [] }),
  },
  {
    expected: 'must have a lowercase SHA-256 hash',
    label: 'null file hash',
    value: (lock) => ({ ...lock, files: { 'managed/a.txt': null } }),
  },
  {
    expected: 'must have a lowercase SHA-256 hash',
    label: 'uppercase file hash',
    value: (lock) => ({
      ...lock,
      files: { 'managed/a.txt': 'A'.repeat(SHA256_LENGTH) },
    }),
  },
  {
    expected: 'must have a lowercase SHA-256 hash',
    label: 'short file hash',
    value: (lock) => ({
      ...lock,
      files: { 'managed/a.txt': 'a'.repeat(SHA256_LENGTH - 1) },
    }),
  },
  {
    expected: 'must be a normalized repository-relative path',
    label: 'unsafe file path',
    value: (lock) => ({
      ...lock,
      files: { '../outside.txt': 'a'.repeat(SHA256_LENGTH) },
    }),
  },
  {
    expected: 'repository-owned control seam',
    label: 'reserved control file path',
    value: (lock) => ({
      ...lock,
      files: { [SYNC_POLICY_FILE]: 'a'.repeat(SHA256_LENGTH) },
    }),
  },
  {
    expected: 'must be unique',
    label: 'duplicate seeds',
    value: (lock) => ({ ...lock, seeds: ['docs/a.txt', 'docs/a.txt'] }),
  },
  {
    expected: 'must be a normalized repository-relative path',
    label: 'unsafe seed path',
    value: (lock) => ({ ...lock, seeds: ['../outside.txt'] }),
  },
  {
    expected: 'overlaps repository-owned seed path "docs"',
    label: 'file and seed ownership overlap',
    value: (lock) => ({
      ...lock,
      files: { 'docs/a.txt': 'a'.repeat(SHA256_LENGTH) },
      seeds: ['docs'],
    }),
  },
];

describe('lock ownership schema', () => {
  it.each(INVALID_LOCKS)('rejects $label before sync mutation', ({
    expected,
    value,
  }) => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    write(
      consumer,
      'sync-standards.lock',
      `${JSON.stringify(value(readLock(consumer)), null, 2)}\n`,
    );
    const filesBefore = listRelativeFiles(consumer);
    const contentsBefore = new Map(
      filesBefore.map((rel) => [rel, read(consumer, rel)]),
    );

    const result = sync(up, consumer);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(expected);
    expect(listRelativeFiles(consumer)).toEqual(filesBefore);
    for (const [rel, contents] of contentsBefore) {
      expect(read(consumer, rel)).toBe(contents);
    }
  });
});

describe('doctor', () => {
  it('reports every missing integration seam together', () => {
    const consumer = mkTmp('sync-cons-');
    write(consumer, 'package.json', '{}');
    const doctor = run(consumer, ['doctor', '--dir', consumer]);
    expect(doctor.status).toBe(1);
    expect(doctor.stderr).toContain('biome.jsonc must extend');
    expect(doctor.stderr).toContain('AGENTS.local.md must exist');
    expect(doctor.stderr).toContain('.github/dependabot.yml must exist');
    expect(doctor.stderr).toContain('@davidvornholt/standards');
    expect(doctor.stderr).toContain('script "check"');
    expect(doctor.stderr).toContain('script "check:fix"');
  });

  it('reports invalid Dependabot structure and missing baseline ecosystems', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(
      consumer,
      '.github/dependabot.yml',
      [
        'version: 1',
        'updates:',
        '  - package-ecosystem: nix',
        '    directory: /',
        '',
      ].join('\n'),
    );

    const doctor = run(consumer, ['doctor', '--dir', consumer]);

    expect(doctor.status).toBe(1);
    expect(doctor.stderr).toContain('must use version: 2');
    expect(doctor.stderr).toContain('must define schedule.interval');
    expect(doctor.stderr).toContain('root-directory bun ecosystem');
    expect(doctor.stderr).toContain('root-directory github-actions ecosystem');
  });

  it('reports malformed Dependabot YAML as an integration problem', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/dependabot.yml', 'version: [\n');

    const doctor = run(consumer, ['doctor', '--dir', consumer]);

    expect(doctor.status).toBe(1);
    expect(doctor.stderr).toContain('must contain valid YAML');
  });

  it('rejects unsupported and incomplete cron schedules', () => {
    const { consumer } = initConsumer(buildUpstream());
    const dependabotPath = '.github/dependabot.yml';
    write(
      consumer,
      dependabotPath,
      read(consumer, dependabotPath)
        .replace('interval: weekly', 'interval: never')
        .replace('interval: weekly', 'interval: cron'),
    );

    const doctor = run(consumer, ['doctor', '--dir', consumer]);

    expect(doctor.status).toBe(1);
    expect(doctor.stderr).toContain('unsupported schedule.interval');
    expect(doctor.stderr).toContain('must define schedule.cronjob');
  });

  it('accepts additional ecosystems with a shared group schedule', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(
      consumer,
      '.github/dependabot.yml',
      [
        'version: 2',
        'multi-ecosystem-groups:',
        '  infrastructure:',
        '    schedule:',
        '      interval: weekly',
        'updates:',
        '  - package-ecosystem: bun',
        '    directory: /',
        '    schedule:',
        '      interval: weekly',
        '  - package-ecosystem: github-actions',
        '    directory: /',
        '    schedule:',
        '      interval: weekly',
        '  - package-ecosystem: nix',
        '    directories:',
        '      - /',
        '      - /infra',
        '    patterns: ["*"]',
        '    multi-ecosystem-group: infrastructure',
        '  - package-ecosystem: opentofu',
        '    directory: /infra',
        '    patterns: ["*"]',
        '    multi-ecosystem-group: infrastructure',
        '',
      ].join('\n'),
    );

    const doctor = run(consumer, ['doctor', '--dir', consumer]);

    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain('consumer integration seams are wired');
  });
});

describe('sync policy integration', () => {
  it('requires upgrading a real v0.4 consumer before adopting current settings', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, 'justfile', "import 'standards.just'\n");
    write(
      consumer,
      '.github/settings.json',
      readFileSync(
        join(import.meta.dir, '../../../.github/settings.json'),
        'utf8',
      ),
    );
    write(
      consumer,
      '.github/settings.local.json',
      JSON.stringify({ repository: {}, rulesets: [], environments: [] }),
    );
    setStandardsVersion(consumer, '0.4.0');

    const legacy = run(consumer, ['doctor', '--dir', consumer], {
      engine: LEGACY_ENGINE,
    });
    expect(legacy.status).toBe(1);
    expect(legacy.stderr).toContain('has unknown key "environments"');

    const currentBeforeUpgrade = run(consumer, ['doctor', '--dir', consumer]);
    expect(currentBeforeUpgrade.status).toBe(1);
    expect(currentBeforeUpgrade.stderr).toContain(
      'exact stable version >=0.5.0',
    );

    setStandardsVersion(consumer, '0.5.0');
    expect(run(consumer, ['doctor', '--dir', consumer]).status).toBe(0);
  });

  it('aggregates malformed policy and incompatible CLI problems', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(
      consumer,
      SYNC_POLICY_FILE,
      JSON.stringify({ ref: 'refs/tags/v0.5.0' }),
    );
    setStandardsVersion(consumer, '0.4.0');
    rmSync(join(consumer, 'AGENTS.local.md'));

    for (const command of ['doctor', 'check']) {
      const result = run(consumer, [command, '--dir', consumer]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('requires boolean "scheduledSync"');
      expect(result.stderr).toContain('exact stable version >=0.5.0');
      expect(result.stderr).toContain('AGENTS.local.md must exist');
    }
  });

  it('accepts only exact compatible CLI versions for non-default policy', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(
      consumer,
      SYNC_POLICY_FILE,
      JSON.stringify({ ref: 'refs/tags/v0.5.0', scheduledSync: true }),
    );

    setStandardsVersion(consumer, '^0.5.0');
    expect(run(consumer, ['doctor', '--dir', consumer]).stderr).toContain(
      'exact stable version >=0.5.0',
    );

    setStandardsVersion(consumer, '0.5.0');
    expect(run(consumer, ['doctor', '--dir', consumer]).status).toBe(0);
  });
});

describe('ignored source roots', () => {
  const ignoredSourceCases = [
    {
      expected:
        'snapshot root must not contain ignored path component ".git": .git/config',
      kind: 'managed root',
      prepare: (up: string): void => {
        const manifest = JSON.parse(read(up, 'sync-standards.json')) as {
          paths: Array<string>;
        };
        manifest.paths.push('.git/config');
        write(up, '.git/config', 'must not mirror\n');
        write(up, 'sync-standards.json', JSON.stringify(manifest));
      },
    },
    {
      expected:
        'snapshot base must not contain ignored path component ".git": template/.git/seed',
      kind: 'seed output base',
      prepare: (up: string): void => {
        const manifest = JSON.parse(read(up, 'sync-standards.json')) as Record<
          string,
          unknown
        >;
        write(
          up,
          'sync-standards.json',
          JSON.stringify({ ...manifest, seedDir: 'template/.git/seed' }),
        );
        write(up, 'template/.git/seed/seed.txt', 'must not seed\n');
      },
    },
  ] as const;

  for (const command of ['init', 'sync'] as const) {
    it.each([
      ...ignoredSourceCases,
    ])(`rejects an explicit ignored source $kind during ${command} without consumer mutation`, ({
      expected,
      prepare,
    }) => {
      const up = buildUpstream();
      const consumer =
        command === 'init' ? mkTmp('sync-cons-') : initConsumer(up).consumer;
      write(consumer, 'actor-owned.txt', 'keep me\n');
      prepare(up);
      const filesBefore = listRelativeFiles(consumer);
      const contentsBefore = new Map(
        filesBefore.map((rel) => [rel, read(consumer, rel)]),
      );
      const transactionArtifactsBefore = transactionArtifacts(consumer);

      const result =
        command === 'init'
          ? run(consumer, ['init', '--from', up, '--dir', consumer])
          : sync(up, consumer);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(expected);
      expect(listRelativeFiles(consumer)).toEqual(filesBefore);
      expect(transactionArtifacts(consumer)).toEqual(
        transactionArtifactsBefore,
      );
      for (const [rel, contents] of contentsBefore) {
        expect(read(consumer, rel)).toBe(contents);
      }
    });
  }
});

describe('sync source compatibility', () => {
  it.each([
    'init',
    'sync',
  ] as const)('rejects an empty upstream during %s without consumer mutation', (command) => {
    const up = buildUpstream();
    const consumer =
      command === 'init' ? mkTmp('sync-cons-') : initConsumer(up).consumer;
    write(consumer, 'actor-owned.txt', 'keep me\n');
    write(up, 'managed/a.txt', 'must not apply\n');
    const manifest = JSON.parse(read(up, 'sync-standards.json')) as Record<
      string,
      unknown
    >;
    write(
      up,
      'sync-standards.json',
      JSON.stringify({ ...manifest, upstream: '' }),
    );
    const filesBefore = listRelativeFiles(consumer);
    const contentsBefore = new Map(
      filesBefore.map((rel) => [rel, read(consumer, rel)]),
    );

    const result =
      command === 'init'
        ? run(consumer, ['init', '--from', up, '--dir', consumer])
        : sync(up, consumer);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'requires non-empty string "upstream" and string "seedDir"',
    );
    expect(listRelativeFiles(consumer)).toEqual(filesBefore);
    for (const [rel, contents] of contentsBefore) {
      expect(read(consumer, rel)).toBe(contents);
    }
  });

  it('rejects a source that claims repo-owned policy before mutation and check', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    const lockBefore = read(consumer, 'sync-standards.lock');
    const managedBefore = read(consumer, 'managed/a.txt');
    const controllerBefore = read(consumer, SYNC_POLICY_CONTRACT_PATH);
    const policyBefore = read(consumer, SYNC_POLICY_FILE);
    const claimedPolicy = `${JSON.stringify({
      ref: DEFAULT_SYNC_POLICY.ref,
      scheduledSync: false,
    })}\n`;
    rmSync(join(up, 'template', SYNC_POLICY_FILE));
    write(up, SYNC_POLICY_FILE, claimedPolicy);
    write(up, 'managed/a.txt', 'should not apply\n');
    write(
      up,
      'sync-standards.json',
      JSON.stringify({
        upstream: up,
        seedDir: 'template',
        syncPolicyContractVersion: SYNC_POLICY_CONTRACT_VERSION,
        paths: [...STD_PATHS, SYNC_POLICY_FILE],
      }),
    );

    const result = sync(up, consumer);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `repository-owned control seam "${SYNC_POLICY_FILE}"`,
    );
    expect(read(consumer, 'managed/a.txt')).toBe(managedBefore);
    expect(read(consumer, SYNC_POLICY_CONTRACT_PATH)).toBe(controllerBefore);
    expect(read(consumer, SYNC_POLICY_FILE)).toBe(policyBefore);
    expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);

    write(consumer, SYNC_POLICY_FILE, claimedPolicy);
    const previousLock = JSON.parse(lockBefore) as Lock;
    const claimedLock = {
      ...previousLock,
      files: {
        ...previousLock.files,
        [SYNC_POLICY_FILE]: sha256(claimedPolicy),
      },
    };
    write(
      consumer,
      'sync-standards.lock',
      `${JSON.stringify(claimedLock, null, 2)}\n`,
    );
    const check = run(consumer, ['check', '--dir', consumer]);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain(
      `repository-owned control seam "${SYNC_POLICY_FILE}"`,
    );
  });
});

describe('sync controller compatibility', () => {
  it('rejects a v1 source that omits a managed controller boundary', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    const lockBefore = read(consumer, 'sync-standards.lock');
    const managedBefore = read(consumer, 'managed/a.txt');
    const controllerBefore = read(consumer, SYNC_POLICY_CONTRACT_PATH);
    const policyBefore = read(consumer, SYNC_POLICY_FILE);
    write(up, 'managed/a.txt', 'should not apply\n');
    write(
      up,
      'sync-standards.json',
      JSON.stringify({
        upstream: up,
        seedDir: 'template',
        syncPolicyContractVersion: SYNC_POLICY_CONTRACT_VERSION,
        paths: STD_PATHS.filter((path) => path !== SYNC_POLICY_CONTROLLER_PATH),
      }),
    );

    const result = sync(up, consumer);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `requires managed path "${SYNC_POLICY_CONTROLLER_PATH}"`,
    );
    expect(read(consumer, 'managed/a.txt')).toBe(managedBefore);
    expect(read(consumer, SYNC_POLICY_CONTRACT_PATH)).toBe(controllerBefore);
    expect(read(consumer, SYNC_POLICY_FILE)).toBe(policyBefore);
    expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
  });

  it('rejects v1 sources missing any required controller file before mutation', () => {
    for (const missingFile of SYNC_POLICY_CONTROLLER_FILES) {
      const up = buildUpstream();
      const { consumer } = initConsumer(up);
      const lockBefore = read(consumer, 'sync-standards.lock');
      const managedBefore = read(consumer, 'managed/a.txt');
      const controllerBefore = read(consumer, SYNC_POLICY_CONTRACT_PATH);
      const policyBefore = read(consumer, SYNC_POLICY_FILE);
      write(up, 'managed/a.txt', 'should not apply\n');
      rmSync(join(up, SYNC_POLICY_CONTROLLER_PATH, missingFile));

      const result = sync(up, consumer);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `requires controller file "${SYNC_POLICY_CONTROLLER_PATH}/${missingFile}"`,
      );
      expect(read(consumer, 'managed/a.txt')).toBe(managedBefore);
      expect(read(consumer, SYNC_POLICY_CONTRACT_PATH)).toBe(controllerBefore);
      expect(read(consumer, SYNC_POLICY_FILE)).toBe(policyBefore);
      expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
    }
  });

  it('rejects a mismatched controller generation before mutation', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    const lockBefore = read(consumer, 'sync-standards.lock');
    const managedBefore = read(consumer, 'managed/a.txt');
    write(up, 'managed/a.txt', 'should not apply\n');
    write(
      up,
      SYNC_POLICY_CONTRACT_PATH,
      read(up, SYNC_POLICY_CONTRACT_PATH).replace(
        'SYNC_POLICY_CONTRACT_VERSION=1',
        'SYNC_POLICY_CONTRACT_VERSION=2',
      ),
    );

    const result = sync(up, consumer);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'must be generated for SYNC_POLICY_CONTRACT_VERSION = 1',
    );
    expect(read(consumer, 'managed/a.txt')).toBe(managedBefore);
    expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
  });
});

describe('source reserved sync targets', () => {
  const conflicts = [
    {
      expected: 'CLI-owned lock "sync-standards.lock"',
      label: 'managed lock',
      prepare: (up: string): void => {
        const manifest = JSON.parse(read(up, 'sync-standards.json')) as {
          paths: Array<string>;
        };
        manifest.paths.push('sync-standards.lock');
        write(up, 'sync-standards.lock', 'source-owned lock\n');
        write(up, 'sync-standards.json', JSON.stringify(manifest));
      },
    },
    {
      expected: `CLI-owned transaction namespace "managed/${RESERVED_ATOMIC_TAIL}"`,
      label: 'managed transaction artifact',
      prepare: (up: string): void => {
        write(up, `managed/${RESERVED_ATOMIC_TAIL}`, 'source-owned tail\n');
      },
    },
    {
      expected: 'CLI-owned lock "sync-standards.lock"',
      label: 'seed lock',
      prepare: (up: string): void => {
        write(up, 'template/sync-standards.lock', 'source-owned lock seed\n');
      },
    },
    {
      expected: `CLI-owned transaction namespace "nested/${RESERVED_ATOMIC_TAIL}"`,
      label: 'seed transaction artifact',
      prepare: (up: string): void => {
        write(
          up,
          `template/nested/${RESERVED_ATOMIC_TAIL}`,
          'source-owned tail seed\n',
        );
      },
    },
  ] as const;

  it.each([
    { args: [] as ReadonlyArray<string>, mode: 'real sync' },
    { args: ['--dry-run'], mode: 'dry-run' },
  ])('rejects lock and transaction conflicts before reporting during $mode', ({
    args,
  }) => {
    for (const conflict of conflicts) {
      const up = buildUpstream();
      const { consumer } = initConsumer(up);
      const lockBefore = read(consumer, 'sync-standards.lock');
      const managedBefore = read(consumer, 'managed/a.txt');
      conflict.prepare(up);
      write(up, 'managed/a.txt', 'must not report or apply\n');

      const result = sync(up, consumer, args);

      expect(result.status, conflict.label).toBe(1);
      expect(result.stderr, conflict.label).toContain(conflict.expected);
      expect(result.stdout, conflict.label).not.toContain('would update');
      expect(result.stdout, conflict.label).not.toContain('updated managed');
      expect(read(consumer, 'managed/a.txt'), conflict.label).toBe(
        managedBefore,
      );
      expect(read(consumer, 'sync-standards.lock'), conflict.label).toBe(
        lockBefore,
      );
    }
  });

  it('keeps repository-owned seeds and non-reserved atomic lookalikes valid', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    write(up, `template/nested/${ATOMIC_TAIL_LOOKALIKE}`, 'lookalike seed\n');

    const result = sync(up, consumer);

    expect(result.status).toBe(0);
    expect(readLock(consumer).seeds).toContain(
      `nested/${ATOMIC_TAIL_LOOKALIKE}`,
    );
    expect(readLock(consumer).seeds).toContain(SYNC_POLICY_FILE);
  });
});

describe('sync', () => {
  it('prunes the legacy orphan CLI workspace after its managed file is removed', () => {
    const up = buildUpstream([...STD_PATHS, LEGACY_ORPHAN_POLICY_PATH]);
    write(up, LEGACY_ORPHAN_POLICY_PATH, 'legacy generated policy\n');
    const { consumer } = initConsumer(up);
    expect(existsSync(join(consumer, 'packages/standards-cli'))).toBe(true);
    write(
      up,
      'sync-standards.json',
      JSON.stringify({
        upstream: up,
        seedDir: 'template',
        syncPolicyContractVersion: SYNC_POLICY_CONTRACT_VERSION,
        paths: STD_PATHS,
      }),
    );

    expect(sync(up, consumer).status).toBe(0);
    expect(existsSync(join(consumer, 'packages/standards-cli'))).toBe(false);
  });

  it('preserves unmanaged empty descendants while pruning managed parents', () => {
    const retired = 'legacy/nested/old.txt';
    const up = buildUpstream([...STD_PATHS, retired]);
    write(up, retired, 'retired\n');
    const { consumer } = initConsumer(up);
    mkdirSync(join(consumer, 'legacy/unmanaged/empty'), { recursive: true });
    write(
      up,
      'sync-standards.json',
      JSON.stringify({
        upstream: up,
        seedDir: 'template',
        syncPolicyContractVersion: SYNC_POLICY_CONTRACT_VERSION,
        paths: STD_PATHS,
      }),
    );

    expect(sync(up, consumer).status).toBe(0);
    expect(existsSync(join(consumer, 'legacy/nested'))).toBe(false);
    expect(existsSync(join(consumer, 'legacy/unmanaged/empty'))).toBe(true);
  });

  it('uses new managed paths from the upstream manifest immediately', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    write(up, 'newly-managed.txt', 'new\n');
    write(
      up,
      'sync-standards.json',
      JSON.stringify({
        upstream: up,
        seedDir: 'template',
        syncPolicyContractVersion: SYNC_POLICY_CONTRACT_VERSION,
        paths: [...STD_PATHS, 'newly-managed.txt'],
      }),
    );

    const result = sync(up, consumer);

    expect(result.status).toBe(0);
    expect(read(consumer, 'newly-managed.txt')).toBe('new\n');
    expect(readLock(consumer).files['newly-managed.txt']).toBeDefined();
    expect(sync(up, consumer, ['--dry-run']).stdout).toContain(
      'dry run: already in sync; no changes',
    );
  });
});

describe('sync historical ownership', () => {
  it.each([
    { args: [] as ReadonlyArray<string>, label: 'sync' },
    { args: ['--dry-run'], label: 'dry-run' },
  ])('rejects historical managed/seed overlap before target inspection during $label', ({
    args,
  }) => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    const lock = readLock(consumer);
    lock.files['README.md'] = sha256('old canonical README\n');
    write(
      consumer,
      'sync-standards.lock',
      `${JSON.stringify(lock, null, 2)}\n`,
    );
    write(consumer, 'actor.txt', 'actor-owned\n');
    symlinkSync('actor.txt', join(consumer, 'README.md'));
    const lockBefore = read(consumer, 'sync-standards.lock');

    const result = sync(up, consumer, args);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Previously managed path "README.md" overlaps repository-owned seed path "README.md"',
    );
    expect(result.stderr).not.toContain(
      'consumer repository path must not be a symbolic link',
    );
    expect(lstatSync(join(consumer, 'README.md')).isSymbolicLink()).toBe(true);
    expect(read(consumer, 'actor.txt')).toBe('actor-owned\n');
    expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
  });
});

describe('sync ownership transitions', () => {
  it('protects contract-v1 seed ownership when a legacy lock source promotes a seed', () => {
    const up = buildUpstream();
    write(up, 'template/README.md', 'upstream seed\n');
    const { consumer } = initConsumer(up);
    write(consumer, 'README.md', 'consumer-owned\n');
    const { seeds: _seeds, ...legacyLock } = readLock(consumer);
    write(
      consumer,
      'sync-standards.lock',
      `${JSON.stringify(legacyLock, null, 2)}\n`,
    );
    const lockBefore = read(consumer, 'sync-standards.lock');
    rmSync(join(up, 'template/README.md'));
    write(up, 'README.md', 'new canonical content\n');
    const manifest = JSON.parse(read(up, 'sync-standards.json')) as {
      paths: Array<string>;
    };
    manifest.paths.push('README.md');
    write(up, 'sync-standards.json', JSON.stringify(manifest));

    const result = sync(up, consumer);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'would take ownership of repository-owned seed path "README.md"',
    );
    expect(read(consumer, 'README.md')).toBe('consumer-owned\n');
    expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
  });

  it('rejects demoting a previously managed file to a seed before mutation', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    const managedBefore = read(consumer, 'managed/a.txt');
    const lockBefore = read(consumer, 'sync-standards.lock');
    const manifest = JSON.parse(read(up, 'sync-standards.json')) as {
      paths: Array<string>;
    };
    manifest.paths = manifest.paths.filter((path) => path !== 'managed');
    write(up, 'sync-standards.json', JSON.stringify(manifest));
    write(up, 'template/managed/a.txt', 'new seed default\n');

    const result = sync(up, consumer);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'would take ownership of previously managed path "managed/a.txt"',
    );
    expect(read(consumer, 'managed/a.txt')).toBe(managedBefore);
    expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
  });
});

describe('sync lock metadata preview', () => {
  it('records a newly observed seed and protects its ownership on later syncs', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    write(up, 'template/future-seed.txt', 'future default\n');
    const lockBeforeObservation = read(consumer, 'sync-standards.lock');

    const preview = sync(up, consumer, ['--dry-run']);

    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain(
      'would update sync-standards.lock (metadata)',
    );
    expect(preview.stdout).toContain(
      'dry run: 0 to create, 0 to update, 0 to delete, 1 lock metadata update(s), 0 sync policy update(s)',
    );
    expect(existsSync(join(consumer, 'future-seed.txt'))).toBe(false);
    expect(read(consumer, 'sync-standards.lock')).toBe(lockBeforeObservation);

    const observed = sync(up, consumer);

    expect(observed.status).toBe(0);
    expect(existsSync(join(consumer, 'future-seed.txt'))).toBe(false);
    expect(readLock(consumer).seeds).toContain('future-seed.txt');
    rmSync(join(up, 'template/future-seed.txt'));
    write(up, 'future-seed.txt', 'future canonical\n');
    const manifest = JSON.parse(read(up, 'sync-standards.json')) as {
      paths: Array<string>;
    };
    manifest.paths.push('future-seed.txt');
    write(up, 'sync-standards.json', JSON.stringify(manifest));
    const lockBeforePromotion = read(consumer, 'sync-standards.lock');

    const promoted = sync(up, consumer);

    expect(promoted.status).toBe(1);
    expect(promoted.stderr).toContain(
      'would take ownership of repository-owned seed path "future-seed.txt"',
    );
    expect(existsSync(join(consumer, 'future-seed.txt'))).toBe(false);
    expect(read(consumer, 'sync-standards.lock')).toBe(lockBeforePromotion);
  });

  it('previews legacy seed-baseline lock migration without writing it', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    const { seeds: _seeds, ...legacyLock } = readLock(consumer);
    write(
      consumer,
      'sync-standards.lock',
      `${JSON.stringify(legacyLock, null, 2)}\n`,
    );
    const lockBefore = read(consumer, 'sync-standards.lock');

    const preview = sync(up, consumer, ['--dry-run']);

    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain(
      'would update sync-standards.lock (metadata)',
    );
    expect(preview.stdout).toContain(
      'dry run: 0 to create, 0 to update, 0 to delete, 1 lock metadata update(s), 0 sync policy update(s)',
    );
    expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);

    expect(sync(up, consumer).status).toBe(0);
    expect(readLock(consumer).seeds).toContain('README.md');
    expect(readLock(consumer).seeds).toContain('seed.txt');
  });
});

describe('sync mirror', () => {
  it('deletes a consumer file removed from upstream and prunes the lock', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    rmSync(join(up, 'managed/b.txt'));
    const result = sync(up, consumer);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('deleted managed/b.txt (removed upstream)');
    expect(existsSync(join(consumer, 'managed/b.txt'))).toBe(false);
    expect(readLock(consumer).files['managed/b.txt']).toBeUndefined();
  });

  it('updates a changed upstream file and check passes afterward', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    write(up, 'managed/a.txt', 'alpha v2\n');
    const result = sync(up, consumer);
    expect(result.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha v2\n');
    expect(run(consumer, ['check', '--dir', consumer]).status).toBe(0);
  });

  it('dry-run writes nothing, then a real sync applies the change', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    const lockBefore = read(consumer, 'sync-standards.lock');
    write(up, 'managed/a.txt', 'alpha v2\n');
    const dry = sync(up, consumer, ['--dry-run']);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('would update managed/a.txt');
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
    sync(up, consumer);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha v2\n');
  });

  it('dry-run reports no changes when already in sync', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    const dry = sync(up, consumer, ['--dry-run']);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('dry run: already in sync; no changes');
  });

  it('creates no transaction artifacts when already in sync', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    const before = listRelativeFiles(consumer);

    const result = sync(up, consumer);

    expect(result.status).toBe(0);
    expect(listRelativeFiles(consumer)).toEqual(before);
  });

  it('keeps existing recovery history out of Git status and staging', () => {
    const up = buildUpstream();
    const { consumer, result: initialized } = initConsumer(up);
    expect(initialized.status).toBe(0);
    const retainedAfterInit = retainedRecoveryArtifacts(consumer);
    expect(retainedAfterInit.length).toBeGreaterThan(0);
    git(consumer, ['init', '--quiet', '-b', 'main']);
    expect(git(consumer, ['status', '--short'])).toContain('.standards-');

    const noOp = sync(up, consumer);
    expect(noOp.status).toBe(0);
    expect(retainedRecoveryArtifacts(consumer)).toEqual(retainedAfterInit);
    expect(git(consumer, ['status', '--short'])).not.toContain('.standards-');
    git(consumer, ['add', '-A']);
    expect(git(consumer, ['diff', '--cached', '--name-only'])).not.toContain(
      '.standards-',
    );
    git(consumer, ['commit', '--quiet', '-m', 'initial']);
    expect(git(consumer, ['status', '--short'])).toBe('');

    write(up, 'managed/a.txt', 'alpha v2\n');
    const changed = sync(up, consumer);
    expect(changed.status).toBe(0);
    expect(retainedRecoveryArtifacts(consumer).length).toBeGreaterThan(
      retainedAfterInit.length,
    );
    const status = git(consumer, ['status', '--short']);
    expect(status).toContain('managed/a.txt');
    expect(status).toContain('sync-standards.lock');
    expect(status).not.toContain('.standards-');

    git(consumer, ['add', '-A']);
    const staged = git(consumer, ['diff', '--cached', '--name-only']);
    expect(staged).toContain('managed/a.txt');
    expect(staged).toContain('sync-standards.lock');
    expect(staged).not.toContain('.standards-');
  });
});

it('deletes a previously managed nested root when its source parent disappears', () => {
  const nestedRoot = 'managed/future';
  const paths = STD_PATHS.map((path) =>
    path === 'managed' ? nestedRoot : path,
  );
  const up = buildUpstream(paths);
  write(up, `${nestedRoot}/retired.txt`, 'retired\n');
  const { consumer, result: init } = initConsumer(up);
  expect(init.status).toBe(0);
  expect(read(consumer, `${nestedRoot}/retired.txt`)).toBe('retired\n');

  rmSync(join(up, 'managed'), { recursive: true });
  const result = sync(up, consumer);

  expect(result.status).toBe(0);
  expect(result.stdout).toContain(
    `deleted ${nestedRoot}/retired.txt (removed upstream)`,
  );
  expect(existsSync(join(consumer, nestedRoot))).toBe(false);
  expect(readLock(consumer).files[`${nestedRoot}/retired.txt`]).toBeUndefined();
});

describe('Git exclusion filesystem boundary', () => {
  it('rejects a linked Git exclusion target before consumer mutation', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    git(consumer, ['init', '--quiet', '-b', 'main']);
    const outside = mkTmp('sync-git-exclude-outside-');
    write(outside, 'exclude', 'outside unchanged\n');
    const exclude = join(consumer, '.git/info/exclude');
    rmSync(exclude);
    symlinkSync(join(outside, 'exclude'), exclude);
    const managedBefore = read(consumer, 'managed/a.txt');
    const lockBefore = read(consumer, 'sync-standards.lock');
    write(up, 'managed/a.txt', 'must not apply\n');

    const result = sync(up, consumer);

    expect(result.status).toBe(1);
    expect(read(consumer, 'managed/a.txt')).toBe(managedBefore);
    expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
    expect(read(outside, 'exclude')).toBe('outside unchanged\n');
    expect(lstatSync(exclude).isSymbolicLink()).toBe(true);
  });
});

describe('prototype-named lock entries', () => {
  it('records every valid filename during init', () => {
    const up = buildUpstream();
    addPrototypeNamedFiles(up);

    const { consumer, result } = initConsumer(up);

    expect(result.status).toBe(0);
    expect(prototypeNamedLockEntries(consumer)).toEqual(
      expectedPrototypeNamedLockEntries(true),
    );
    expect(run(consumer, ['check', '--dir', consumer]).status).toBe(0);
  });

  it('records every valid filename added by sync', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    addPrototypeNamedFiles(up);

    const result = sync(up, consumer);

    expect(result.status).toBe(0);
    expect(prototypeNamedLockEntries(consumer)).toEqual(
      expectedPrototypeNamedLockEntries(true),
    );
    expect(run(consumer, ['check', '--dir', consumer]).status).toBe(0);
  });

  it('deletes removed files and their own lock entries', () => {
    const up = buildUpstream();
    addPrototypeNamedFiles(up);
    const { consumer } = initConsumer(up);
    removePrototypeNamedFiles(up);

    const result = sync(up, consumer);

    expect(result.status).toBe(0);
    expect(prototypeNamedLockEntries(consumer)).toEqual(
      expectedPrototypeNamedLockEntries(false),
    );
    for (const file of PROTOTYPE_NAMED_FILES) {
      expect(existsSync(join(consumer, file))).toBe(false);
    }
  });
});

describe('sync dry-run recovery boundary', () => {
  it('leaves a pending transaction and managed files unchanged', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    writePendingTransaction(consumer);
    const managedPaths = ['managed/a.txt', 'sync-standards.lock'] as const;
    const artifactPaths = [
      `${TRANSACTION_DIRECTORY}/${TRANSACTION_JOURNAL}`,
      `${TRANSACTION_DIRECTORY}/${TRANSACTION_OWNER}`,
    ] as const;
    const before = new Map(
      [...managedPaths, ...artifactPaths].map((path) => [
        path,
        readFileSync(join(consumer, path)),
      ]),
    );
    const artifactNames = readdirSync(
      join(consumer, TRANSACTION_DIRECTORY),
    ).sort();

    const dry = sync(up, consumer, ['--dry-run']);

    expect(dry.status).toBe(1);
    expect(dry.stderr).toContain(
      `Pending filesystem recovery: ${TRANSACTION_DIRECTORY}`,
    );
    expect(dry.stderr).toContain(
      'Rerun this `bun standards sync` command without `--dry-run` to recover the pending transaction before previewing',
    );
    expect(readdirSync(join(consumer, TRANSACTION_DIRECTORY)).sort()).toEqual(
      artifactNames,
    );
    for (const [path, contents] of before) {
      expect(readFileSync(join(consumer, path))).toEqual(contents);
    }
  });
});

describe('ref pinning', () => {
  it('persists an explicit qualified tag and bare sync keeps using it', () => {
    const { up, url, taggedSha } = buildGitUpstream();
    const { consumer } = initConsumer(up);

    const pinned = sync(url, consumer, ['--ref', 'refs/tags/v1']);
    expect(pinned.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(readLock(consumer).ref).toBe('refs/tags/v1');
    expect(readLock(consumer).sha).toBe(taggedSha);
    expect(JSON.parse(read(consumer, SYNC_POLICY_FILE))).toEqual({
      ref: 'refs/tags/v1',
      scheduledSync: true,
    });

    const bare = run(consumer, ['sync', '--dir', consumer]);
    expect(bare.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(readLock(consumer).sha).toBe(taggedSha);
  });

  it('missing policy defaults bare local and workflow sync to main', () => {
    const { up } = buildGitUpstream();
    const { consumer } = initConsumer(up);
    rmSync(join(consumer, SYNC_POLICY_FILE));
    write(up, 'managed/a.txt', 'alpha v3\n');
    git(up, ['add', '-A']);
    git(up, ['commit', '--quiet', '-m', 'v3']);

    const local = run(consumer, ['sync', '--dir', consumer]);
    expect(local.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha v3\n');
    expect(readLock(consumer).ref).toBe(DEFAULT_SYNC_POLICY.ref);

    write(up, 'managed/a.txt', 'alpha v4\n');
    git(up, ['add', '-A']);
    git(up, ['commit', '--quiet', '-m', 'v4']);
    const workflow = run(consumer, ['sync', '--dir', consumer], {
      env: {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'repository_dispatch',
      },
    });
    expect(workflow.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha v4\n');
    expect(existsSync(join(consumer, SYNC_POLICY_FILE))).toBe(false);
  });

  it('bare local and workflow sync use the same configured ref', () => {
    const { up, taggedSha } = buildGitUpstream();
    const { consumer } = initConsumer(up);
    write(
      consumer,
      SYNC_POLICY_FILE,
      JSON.stringify({ ref: 'refs/tags/v1', scheduledSync: true }),
    );

    expect(run(consumer, ['sync', '--dir', consumer]).status).toBe(0);
    expect(readLock(consumer).sha).toBe(taggedSha);

    write(consumer, 'managed/a.txt', 'force workflow restore\n');
    const workflow = run(consumer, ['sync', '--dir', consumer], {
      env: {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'repository_dispatch',
      },
    });
    expect(workflow.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(readLock(consumer).sha).toBe(taggedSha);
  });

  it('dry-run with an override changes neither policy, lock, nor content', () => {
    const { up, url } = buildGitUpstream();
    const { consumer } = initConsumer(up);
    const filesBefore = listRelativeFiles(consumer);
    const policyBefore = read(consumer, SYNC_POLICY_FILE);
    const lockBefore = read(consumer, 'sync-standards.lock');

    const dry = sync(url, consumer, ['--ref', 'refs/tags/v1', '--dry-run']);

    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('would update managed/a.txt');
    expect(dry.stdout).toContain(
      'would update sync-standards.local.json (sync policy)',
    );
    expect(dry.stdout).toContain(
      'dry run: 0 to create, 1 to update, 0 to delete, 1 lock metadata update(s), 1 sync policy update(s)',
    );
    expect(read(consumer, 'managed/a.txt')).toBe('alpha v2\n');
    expect(read(consumer, SYNC_POLICY_FILE)).toBe(policyBefore);
    expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
    expect(listRelativeFiles(consumer)).toEqual(filesBefore);
  });
});

describe('sync policy source-resolution snapshot', () => {
  for (const command of ['bare', 'explicit ref'] as const) {
    it(`rejects a concurrent policy edit during ${command} source resolution`, async () => {
      const { up, url } = buildGitUpstream();
      const { consumer } = initConsumer(up);
      const lockBefore = read(consumer, 'sync-standards.lock');
      const managedBefore = read(consumer, 'managed/a.txt');
      const args =
        command === 'bare'
          ? ['sync', '--dir', consumer]
          : ['sync', '--from', url, '--ref', 'refs/tags/v1', '--dir', consumer];

      const result = await pausedGitFetchRun({ args, consumer });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `${SYNC_POLICY_FILE} changed during sync source selection`,
      );
      expect(JSON.parse(read(consumer, SYNC_POLICY_FILE))).toEqual({
        ref: DEFAULT_SYNC_POLICY.ref,
        scheduledSync: false,
      });
      expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
      expect(read(consumer, 'managed/a.txt')).toBe(managedBefore);
    });
  }
});

describe('policy validation', () => {
  it('requires both policy fields and a supported ref', () => {
    const { up } = buildGitUpstream();
    const { consumer } = initConsumer(up);
    const lockBefore = read(consumer, 'sync-standards.lock');

    for (const invalidPolicy of [
      { ref: DEFAULT_SYNC_POLICY.ref },
      { ref: 'main', scheduledSync: true },
    ]) {
      write(consumer, SYNC_POLICY_FILE, JSON.stringify(invalidPolicy));
      const result = run(consumer, ['sync', '--dir', consumer]);
      expect(result.status).toBe(1);
      expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
    }
  });

  it('rejects unknown policy keys through the installed controller', () => {
    const { consumer } = initConsumer(buildUpstream());
    const lockBefore = read(consumer, 'sync-standards.lock');
    write(
      consumer,
      SYNC_POLICY_FILE,
      JSON.stringify({ ...DEFAULT_SYNC_POLICY, typo: false }),
    );

    const result = run(consumer, ['sync', '--dir', consumer]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('has unknown key "typo"');
    expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
  });

  it('rejects incompatible effective policy before remote setup', () => {
    const { consumer } = initConsumer(buildUpstream());
    const lockBefore = read(consumer, 'sync-standards.lock');
    const managedBefore = read(consumer, 'managed/a.txt');
    const policyBefore = read(consumer, SYNC_POLICY_FILE);

    setStandardsVersion(consumer, '0.4.0');
    const explicit = sync('file:///missing-standards', consumer, [
      '--ref',
      'refs/tags/v1',
    ]);
    expect(explicit.status).toBe(1);
    expect(explicit.stderr).toContain('exact stable version >=0.5.0');
    expect(explicit.stderr).not.toContain('Cannot fetch');
    expect(read(consumer, SYNC_POLICY_FILE)).toBe(policyBefore);

    setStandardsVersion(consumer, '^0.5.0');
    write(
      consumer,
      SYNC_POLICY_FILE,
      JSON.stringify({ ref: 'refs/tags/v1', scheduledSync: true }),
    );
    const bare = run(consumer, [
      'sync',
      '--from',
      'file:///missing-standards',
      '--dir',
      consumer,
    ]);
    expect(bare.status).toBe(1);
    expect(bare.stderr).toContain('exact stable version >=0.5.0');
    expect(bare.stderr).not.toContain('Cannot fetch');
    expect(read(consumer, 'managed/a.txt')).toBe(managedBefore);
    expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
  });

  it('rejects a v0.4 default policy before source resolution with or without the controller', () => {
    for (const controllerPresent of [true, false]) {
      const { consumer } = initConsumer(buildUpstream());
      setStandardsVersion(consumer, '0.4.0');
      if (!controllerPresent) {
        removeSyncPolicyController(consumer);
      }
      const lockBefore = read(consumer, 'sync-standards.lock');
      const managedBefore = read(consumer, 'managed/a.txt');
      const policyBefore = read(consumer, SYNC_POLICY_FILE);

      const result = sync('file:///missing-standards', consumer);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('exact stable version >=0.5.0');
      expect(result.stderr).not.toContain('Cannot fetch');
      expect(read(consumer, 'managed/a.txt')).toBe(managedBefore);
      expect(read(consumer, SYNC_POLICY_FILE)).toBe(policyBefore);
      expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
      expect(existsSync(join(consumer, SYNC_POLICY_CONTRACT_PATH))).toBe(
        controllerPresent,
      );
    }
  });
});

describe('legacy policy bootstrap exactness', () => {
  it('rejects unknown policy keys before remote setup without a controller', () => {
    const { consumer } = initConsumer(buildUpstream());
    removeSyncPolicyController(consumer);
    setStandardsVersion(consumer, '0.4.0');
    write(
      consumer,
      SYNC_POLICY_FILE,
      JSON.stringify({ ...DEFAULT_SYNC_POLICY, typo: false }),
    );
    const lockBefore = read(consumer, 'sync-standards.lock');
    const managedBefore = read(consumer, 'managed/a.txt');

    const result = sync('file:///missing-standards', consumer);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('has unknown key "typo"');
    expect(result.stderr).toContain('exact stable version >=0.5.0');
    expect(result.stderr).not.toContain('Cannot fetch');
    expect(read(consumer, 'managed/a.txt')).toBe(managedBefore);
    expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
  });
});

describe('source URL safety', () => {
  it('redacts source credentials and query secrets from fetch errors', () => {
    const consumer = mkTmp('sync-cons-');
    const source =
      'https://sync-user:sync-password@127.0.0.1:1/standards.git?token=query-secret';

    const result = run(consumer, ['init', '--from', source, '--dir', consumer]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('from https://127.0.0.1:1/standards.git');
    expect(result.stderr).not.toContain('sync-user');
    expect(result.stderr).not.toContain('sync-password');
    expect(result.stderr).not.toContain('query-secret');
  });

  it('does not let CWD paths shadow persisted or explicit remote sources', () => {
    const { up } = buildGitUpstream();
    const caller = mkTmp('sync-caller-');
    const shadow = join(caller, 'github:davidvornholt', 'standards');
    cpSync(up, shadow, { recursive: true });
    write(shadow, 'managed/a.txt', 'shadow source\n');
    const relativeShadow = join(caller, 'standards-source');
    cpSync(up, relativeShadow, { recursive: true });
    write(relativeShadow, 'managed/a.txt', 'relative shadow source\n');
    const bin = join(caller, 'bin');
    mkdirSync(bin);
    const wrapper = join(bin, 'git');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(
      wrapper,
      `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = fetch ]; then exit 71; fi\ndone\nexec ${JSON.stringify(realGit)} "$@"\n`,
    );
    chmodSync(wrapper, EXECUTABLE_MODE);

    const cases = [
      {
        explicit: false,
        upstream: 'github:davidvornholt/standards',
      },
      {
        explicit: true,
        upstream: 'github:davidvornholt/standards',
      },
      { explicit: false, upstream: './standards-source' },
    ] as const;
    for (const source of cases) {
      const { consumer } = initConsumer(up);
      const lock = readLock(consumer);
      write(
        consumer,
        'sync-standards.lock',
        `${JSON.stringify({ ...lock, upstream: source.upstream })}\n`,
      );
      const args = [
        'sync',
        ...(source.explicit ? ['--from', source.upstream] : []),
        '--dir',
        consumer,
      ];

      const result = run(caller, args, {
        env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Cannot fetch');
      expect(read(consumer, 'managed/a.txt')).toBe('alpha v2\n');
    }
  });
});

describe('persisted local source authority', () => {
  it('rejects a non-normal absolute upstream path', () => {
    const { up } = buildGitUpstream();
    const { consumer } = initConsumer(up);
    const lock = readLock(consumer);
    const managedBefore = read(consumer, 'managed/a.txt');
    const nonNormal = `${up}/../${basename(up)}`;
    write(
      consumer,
      'sync-standards.lock',
      `${JSON.stringify({ ...lock, upstream: nonNormal })}\n`,
    );
    const lockBefore = read(consumer, 'sync-standards.lock');

    const result = run(consumer, ['sync', '--dir', consumer]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Persisted local standards source must be its canonical absolute realpath',
    );
    expect(read(consumer, 'managed/a.txt')).toBe(managedBefore);
    expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
  });

  it('rejects a persisted source after a parent becomes a symlink', () => {
    const { up } = buildGitUpstream();
    const authority = mkTmp('sync-authority-');
    const parent = join(authority, 'A');
    const source = join(parent, 'source');
    const replacement = join(authority, 'B', 'source');
    cpSync(up, source, { recursive: true });
    cpSync(up, replacement, { recursive: true });
    write(replacement, 'managed/a.txt', 'replacement authority\n');
    const { consumer } = initConsumer(source);
    const lock = readLock(consumer);
    write(
      consumer,
      'sync-standards.lock',
      `${JSON.stringify({ ...lock, upstream: source })}\n`,
    );
    const lockBefore = read(consumer, 'sync-standards.lock');
    const managedBefore = read(consumer, 'managed/a.txt');
    renameSync(parent, join(authority, 'A-old'));
    symlinkSync('B', parent);

    const result = run(consumer, ['sync', '--dir', consumer]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Persisted local standards source must be its canonical absolute realpath',
    );
    expect(read(consumer, 'managed/a.txt')).toBe(managedBefore);
    expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
  });
});

describe('local Git object formats', () => {
  it('accepts locks produced from a local SHA-256 Git repository', () => {
    const up = buildUpstream();
    git(up, ['init', '--quiet', '--object-format=sha256', '-b', 'main']);
    git(up, ['add', '-A']);
    git(up, ['commit', '--quiet', '-m', 'initial']);
    const initialSha = git(up, ['rev-parse', 'HEAD']);

    const { consumer, result: initialized } = initConsumer(up);

    expect(initialized.status).toBe(0);
    expect(initialSha).toHaveLength(SHA256_LENGTH);
    expect(readLock(consumer).sha).toBe(initialSha);
    expect(run(consumer, ['check', '--dir', consumer]).status).toBe(0);

    write(up, 'managed/a.txt', 'sha256 update\n');
    git(up, ['add', '-A']);
    git(up, ['commit', '--quiet', '-m', 'update']);
    const updatedSha = git(up, ['rev-parse', 'HEAD']);

    expect(sync(up, consumer).status).toBe(0);
    expect(readLock(consumer).sha).toBe(updatedSha);
    expect(run(consumer, ['check', '--dir', consumer]).status).toBe(0);
  });
});

describe('ref resolution', () => {
  it('syncs a raw commit sha and records the exact pin', () => {
    const { up, url, taggedSha } = buildGitUpstream();
    const { consumer } = initConsumer(up);

    const result = sync(url, consumer, ['--ref', taggedSha]);

    expect(result.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(readLock(consumer).ref).toBe(taggedSha);
    expect(readLock(consumer).sha).toBe(taggedSha);
  });

  it('rejects raw non-commit objects but accepts an annotated tag ref', () => {
    const { up, url, taggedSha } = buildGitUpstream();
    const { consumer } = initConsumer(up);
    const lockBefore = read(consumer, 'sync-standards.lock');
    const policyBefore = read(consumer, SYNC_POLICY_FILE);
    const objectIds = [
      git(up, ['rev-parse', 'refs/tags/annotated']),
      git(up, ['rev-parse', 'refs/tags/v1^{tree}']),
      git(up, ['rev-parse', 'refs/tags/v1:managed/a.txt']),
    ];

    for (const objectId of objectIds) {
      const result = sync(url, consumer, ['--ref', objectId]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('full object IDs must identify a commit');
      expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
      expect(read(consumer, SYNC_POLICY_FILE)).toBe(policyBefore);
    }

    const qualified = sync(url, consumer, ['--ref', 'refs/tags/annotated']);
    expect(qualified.status).toBe(0);
    expect(readLock(consumer).sha).toBe(taggedSha);
  });

  it('qualified branch and tag select different sides of a name collision', () => {
    const { up, url, taggedSha } = buildGitUpstream();
    const { consumer } = initConsumer(up);
    const branchSha = git(up, ['rev-parse', 'refs/heads/collision']);

    const tag = sync(url, consumer, ['--ref', 'refs/tags/collision']);
    expect(tag.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(readLock(consumer).sha).toBe(taggedSha);

    const branch = sync(url, consumer, ['--ref', 'refs/heads/collision']);
    expect(branch.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha v2\n');
    expect(readLock(consumer).sha).toBe(branchSha);
  });

  it('rejects invalid refs before changing consumer state', () => {
    const { up, url } = buildGitUpstream();
    const { consumer } = initConsumer(up);
    const managedBefore = read(consumer, 'managed/a.txt');
    const lockBefore = read(consumer, 'sync-standards.lock');
    const policyBefore = read(consumer, SYNC_POLICY_FILE);

    for (const invalidRef of ['v1', 'stable', '-u', 'refs/tags/missing']) {
      const result = sync(url, consumer, ['--ref', invalidRef]);
      expect(result.status).toBe(1);
      expect(read(consumer, 'managed/a.txt')).toBe(managedBefore);
      expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
      expect(read(consumer, SYNC_POLICY_FILE)).toBe(policyBefore);
    }
  });

  it('local-path testing ignores policy but an explicit local ref is rejected', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    write(
      consumer,
      SYNC_POLICY_FILE,
      JSON.stringify({ ref: 'refs/tags/v1', scheduledSync: true }),
    );
    write(up, 'managed/a.txt', 'local uncommitted change\n');

    const local = sync(up, consumer);
    expect(local.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('local uncommitted change\n');
    expect(readLock(consumer).ref).toBe('refs/tags/v1');
    expect(JSON.parse(read(consumer, SYNC_POLICY_FILE))).toEqual({
      ref: 'refs/tags/v1',
      scheduledSync: true,
    });

    const explicit = sync(up, consumer, ['--ref', 'refs/tags/v1']);
    expect(explicit.status).toBe(1);
    expect(explicit.stderr).toContain('--ref requires a git URL source');
  });

  it('rejects --ref outside sync, including init', () => {
    const consumer = mkTmp('sync-cons-');
    for (const command of ['check', 'init']) {
      const result = run(consumer, [
        command,
        '--ref',
        'refs/tags/v1',
        '--dir',
        consumer,
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        '--ref is only valid with the sync command',
      );
    }
  });
});

describe('scheduled and legacy sync', () => {
  it('bootstraps a missing controller only from the exact default policy before pinning', () => {
    const { up, url } = buildGitUpstream();
    const { consumer } = initConsumer(up);
    removeSyncPolicyController(consumer);
    write(consumer, SYNC_POLICY_FILE, JSON.stringify(DEFAULT_SYNC_POLICY));
    setStandardsVersion(consumer, '0.5.0');

    const bootstrap = run(consumer, ['sync', '--dir', consumer]);

    expect(bootstrap.status).toBe(0);
    for (const file of SYNC_POLICY_CONTROLLER_FILES) {
      expect(
        existsSync(join(consumer, SYNC_POLICY_CONTROLLER_PATH, file)),
      ).toBe(true);
    }
    expect(existsSync(join(consumer, SYNC_POLICY_CONTRACT_PATH))).toBe(true);
    expect(sync(url, consumer, ['--ref', 'refs/tags/v1']).status).toBe(0);
    expect(JSON.parse(read(consumer, SYNC_POLICY_FILE))).toEqual({
      ref: 'refs/tags/v1',
      scheduledSync: true,
    });
  });

  it('rejects non-default policy while the controller is missing before remote setup', () => {
    const { consumer } = initConsumer(buildUpstream());
    removeSyncPolicyController(consumer);
    write(
      consumer,
      SYNC_POLICY_FILE,
      JSON.stringify({ ref: 'refs/tags/v1', scheduledSync: true }),
    );
    const lockBefore = read(consumer, 'sync-standards.lock');
    const managedBefore = read(consumer, 'managed/a.txt');

    const result = sync('file:///missing-standards', consumer);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "upgrade @davidvornholt/standards, run a bare sync from the repository's default branch, then pin",
    );
    expect(result.stderr).not.toContain('Cannot fetch');
    expect(read(consumer, 'managed/a.txt')).toBe(managedBefore);
    expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
  });

  it('leaves scheduled-run enablement to the zero-install workflow preflight', () => {
    const { up } = buildGitUpstream();
    const { consumer } = initConsumer(up);
    write(
      consumer,
      SYNC_POLICY_FILE,
      JSON.stringify({ ...DEFAULT_SYNC_POLICY, scheduledSync: false }),
    );
    write(up, 'managed/a.txt', 'alpha v3\n');
    git(up, ['add', '-A']);
    git(up, ['commit', '--quiet', '-m', 'v3']);

    const scheduledCli = run(consumer, ['sync', '--dir', consumer], {
      env: { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'schedule' },
    });
    expect(scheduledCli.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha v3\n');

    write(up, 'managed/a.txt', 'alpha v4\n');
    git(up, ['add', '-A']);
    git(up, ['commit', '--quiet', '-m', 'v4']);
    const local = run(consumer, ['sync', '--dir', consumer]);
    expect(local.status).toBe(0);
    expect(read(consumer, 'managed/a.txt')).toBe('alpha v4\n');
  });

  it('rejects a real pre-contract snapshot before changing the controller', () => {
    const { up, url } = buildGitUpstream();
    const { consumer } = initConsumer(up);
    const historicalPaths = git(up, [
      'ls-tree',
      '-r',
      '--name-only',
      'refs/tags/v0.4.0',
    ]);
    const historicalManifest = git(up, [
      'show',
      'refs/tags/v0.4.0:sync-standards.json',
    ]);
    expect(historicalPaths).not.toContain(SYNC_POLICY_CONTRACT_PATH);
    expect(historicalManifest).not.toContain('syncPolicyContractVersion');
    const lockBefore = read(consumer, 'sync-standards.lock');
    const policyBefore = read(consumer, SYNC_POLICY_FILE);
    const controllerBefore = read(consumer, SYNC_POLICY_CONTRACT_PATH);
    const managedBefore = read(consumer, 'managed/a.txt');

    const result = sync(url, consumer, ['--ref', 'refs/tags/v0.4.0']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'must declare syncPolicyContractVersion: 1',
    );
    expect(read(consumer, SYNC_POLICY_CONTRACT_PATH)).toBe(controllerBefore);
    expect(read(consumer, 'managed/a.txt')).toBe(managedBefore);
    expect(read(consumer, SYNC_POLICY_FILE)).toBe(policyBefore);
    expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
  });
});

describe('canonical workflow', () => {
  it('remains a policy-free bare sync delegator compatible with old CLIs', () => {
    const workflow = readFileSync(WORKFLOW, 'utf8');
    expect(workflow).toMatch(BARE_SYNC_STEP);
    expect(workflow).not.toContain('bun standards sync --ref');
    expect(workflow).not.toContain('STANDARDS_SYNC_REF');
    expect(workflow).not.toContain('STANDARDS_AUTO_SYNC');
  });

  it('seeds policy once without adding it to the managed manifest', () => {
    const policy = JSON.parse(readFileSync(POLICY_SEED, 'utf8'));
    const manifest = JSON.parse(readFileSync(ROOT_MANIFEST, 'utf8')) as {
      paths: ReadonlyArray<string>;
    };
    expect(policy).toEqual(DEFAULT_SYNC_POLICY);
    expect(manifest.paths).not.toContain(SYNC_POLICY_FILE);
  });
});

const EMPTY_GITHUB_SEAM = JSON.stringify({
  repository: {},
  rulesets: [],
  environments: [],
});
const CANONICAL_GITHUB_SETTINGS = JSON.stringify({
  repository: { allow_auto_merge: true },
  rulesets: [declaredRuleset('Protect main')],
  environments: [],
});

describe('github', () => {
  it('fails when the canonical declaration is missing', () => {
    const { consumer } = initConsumer(buildUpstream());
    const result = run(consumer, ['github', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('.github/settings.json not found');
  });

  it('fails closed when the origin remote cannot be resolved', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/settings.json', CANONICAL_GITHUB_SETTINGS);
    write(consumer, '.github/settings.local.json', EMPTY_GITHUB_SEAM);
    const result = run(consumer, ['github', '--check', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'cannot determine the GitHub repository from the origin remote',
    );
  });

  it('apply also requires a resolvable origin remote', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/settings.json', CANONICAL_GITHUB_SETTINGS);
    write(consumer, '.github/settings.local.json', EMPTY_GITHUB_SEAM);
    const result = run(consumer, ['github', '--apply', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'cannot determine the GitHub repository from the origin remote',
    );
  });
});

describe('github transaction gate', () => {
  it('apply recovers before loading the declaration or requesting GitHub', () => {
    const { consumer } = initConsumer(buildUpstream());
    writePendingTransaction(consumer);
    const trap = githubRequestTrap(consumer);

    const result = run(consumer, ['github', '--apply', '--dir', consumer], {
      env: { GH_TOKEN: 'test-token' },
      preload: trap.preload,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('.github/settings.json not found');
    expect(existsSync(join(consumer, TRANSACTION_DIRECTORY))).toBe(false);
    expect(existsSync(trap.marker)).toBe(false);
  });

  it('apply makes no request for a valid declaration with irrecoverable WAL', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/settings.json', CANONICAL_GITHUB_SETTINGS);
    write(consumer, '.github/settings.local.json', EMPTY_GITHUB_SEAM);
    git(consumer, ['init', '--quiet']);
    git(consumer, [
      'remote',
      'add',
      'origin',
      'https://github.com/example/standards.git',
    ]);
    writePendingTransaction(consumer);
    write(
      consumer,
      `${TRANSACTION_DIRECTORY}/${TRANSACTION_JOURNAL}`,
      '{irrecoverable',
    );
    const trap = githubRequestTrap(consumer);

    const result = run(consumer, ['github', '--apply', '--dir', consumer], {
      env: { GH_TOKEN: 'test-token' },
      preload: trap.preload,
    });

    expect(result.status).toBe(1);
    expect(existsSync(join(consumer, TRANSACTION_DIRECTORY))).toBe(true);
    expect(existsSync(trap.marker)).toBe(false);
  });

  it('check fails closed on a pending transaction without requesting GitHub', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/settings.json', CANONICAL_GITHUB_SETTINGS);
    write(consumer, '.github/settings.local.json', EMPTY_GITHUB_SEAM);
    git(consumer, ['init', '--quiet']);
    git(consumer, [
      'remote',
      'add',
      'origin',
      'https://github.com/example/standards.git',
    ]);
    writePendingTransaction(consumer);
    const trap = githubRequestTrap(consumer);

    const result = run(consumer, ['github', '--check', '--dir', consumer], {
      env: { GH_TOKEN: 'test-token' },
      preload: trap.preload,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Pending filesystem recovery');
    expect(existsSync(join(consumer, TRANSACTION_DIRECTORY))).toBe(true);
    expect(existsSync(trap.marker)).toBe(false);
  });
});

describe('github integration', () => {
  it('check gates on the declaration once it is present', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/settings.json', CANONICAL_GITHUB_SETTINGS);
    write(consumer, '.github/settings.local.json', EMPTY_GITHUB_SEAM);
    const result = run(consumer, ['check', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'cannot determine the GitHub repository from the origin remote',
    );
  });

  it('doctor requires the local seam once the declaration is synced', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/settings.json', CANONICAL_GITHUB_SETTINGS);
    const result = run(consumer, ['doctor', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('.github/settings.local.json must exist');
  });

  it('doctor rejects a seam that overrides canonical values', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/settings.json', CANONICAL_GITHUB_SETTINGS);
    write(
      consumer,
      '.github/settings.local.json',
      JSON.stringify({
        repository: { allow_auto_merge: false },
        rulesets: [declaredRuleset('Protect main')],
      }),
    );
    const result = run(consumer, ['doctor', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'repository."allow_auto_merge" would override a canonical value',
    );
    expect(result.stderr).toContain(
      'ruleset "Protect main" collides with a canonical ruleset',
    );
  });

  it('rejects --apply outside the github command and combined with --check', () => {
    const consumer = mkTmp('sync-cons-');
    const outside = run(consumer, ['sync', '--apply', '--dir', consumer]);
    expect(outside.status).toBe(1);
    expect(outside.stderr).toContain(
      '--apply is only valid with the github command',
    );
    const combined = run(consumer, [
      'github',
      '--check',
      '--apply',
      '--dir',
      consumer,
    ]);
    expect(combined.status).toBe(1);
    expect(combined.stderr).toContain(
      'github accepts exactly one of --check or --apply',
    );
  });

  it('rejects --check outside the github command', () => {
    const consumer = mkTmp('sync-cons-');
    const result = run(consumer, ['sync', '--check', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '--check is only valid with the github command',
    );
  });
});

describe('help', () => {
  it('fails with usage when no command is given', () => {
    const consumer = mkTmp('sync-cons-');
    const result = run(consumer, ['--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('a command is required');
    expect(result.stderr).toContain('Usage: standards <command>');
  });

  it('prints usage and exits 0 for help, --help, and -h', () => {
    const consumer = mkTmp('sync-cons-');
    for (const spelling of ['help', '--help', '-h']) {
      const result = run(consumer, [spelling]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Usage: standards <command>');
      expect(result.stdout).toContain('remote sources only');
      expect(result.stdout).toContain('refs/heads/<branch>');
    }
  });
});

describe('unknown command', () => {
  it('exits 1 with Unknown command', () => {
    const consumer = mkTmp('sync-cons-');
    const result = run(consumer, ['bogus', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown command');
  });
});

describe('source filesystem boundary', () => {
  it('rejects a source file symlink before a mixed sync writes anything', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    const victimRoot = mkTmp('sync-victim-');
    write(victimRoot, 'victim.txt', 'external\n');
    const lockBefore = read(consumer, 'sync-standards.lock');
    write(up, 'managed/a.txt', 'changed\n');
    rmSync(join(up, 'managed/b.txt'));
    symlinkSync(join(victimRoot, 'victim.txt'), join(up, 'managed/b.txt'));

    const result = sync(up, consumer);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must not be a symbolic link');
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
    expect(read(victimRoot, 'victim.txt')).toBe('external\n');
  });

  it('rejects source managed-directory and seed-directory symlinks', () => {
    for (const target of ['managed', 'template']) {
      const up = buildUpstream();
      const consumer = mkTmp('sync-cons-');
      const victimRoot = mkTmp('sync-victim-');
      write(victimRoot, 'victim.txt', 'external\n');
      rmSync(join(up, target), { recursive: true });
      symlinkSync(victimRoot, join(up, target));

      const result = run(consumer, ['init', '--from', up, '--dir', consumer]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('must not be a symbolic link');
      expect(existsSync(join(consumer, 'sync-standards.lock'))).toBe(false);
      expect(existsSync(join(consumer, 'managed/a.txt'))).toBe(false);
      expect(read(victimRoot, 'victim.txt')).toBe('external\n');
    }
  });

  it('rejects a source seed-file symlink before init writes any seed', () => {
    const up = buildUpstream();
    const consumer = mkTmp('sync-cons-');
    const victimRoot = mkTmp('sync-victim-');
    write(victimRoot, 'victim.txt', 'external\n');
    rmSync(join(up, 'template/seed.txt'));
    symlinkSync(join(victimRoot, 'victim.txt'), join(up, 'template/seed.txt'));

    const result = run(consumer, ['init', '--from', up, '--dir', consumer]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must not be a symbolic link');
    expect(existsSync(join(consumer, 'package.json'))).toBe(false);
    expect(existsSync(join(consumer, 'sync-standards.lock'))).toBe(false);
    expect(read(victimRoot, 'victim.txt')).toBe('external\n');
  });
});

describe('consumer sync filesystem boundary', () => {
  it('rejects a consumer file symlink before a mixed update', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    const victimRoot = mkTmp('sync-victim-');
    write(victimRoot, 'victim.txt', 'external\n');
    const lockBefore = read(consumer, 'sync-standards.lock');
    rmSync(join(consumer, 'managed/a.txt'));
    symlinkSync(
      join(victimRoot, 'victim.txt'),
      join(consumer, 'managed/a.txt'),
    );
    write(up, 'managed/a.txt', 'changed a\n');
    write(up, 'managed/b.txt', 'changed b\n');

    const result = sync(up, consumer);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must not be a symbolic link');
    expect(read(consumer, 'managed/b.txt')).toBe('beta\n');
    expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
    expect(read(victimRoot, 'victim.txt')).toBe('external\n');
  });

  it('rejects dangling file and parent symlinks for creates', () => {
    for (const parentLink of [false, true]) {
      const up = buildUpstream(
        parentLink ? [...STD_PATHS, 'new-managed'] : STD_PATHS,
      );
      const { consumer } = initConsumer(up);
      const victimRoot = mkTmp('sync-victim-');
      const lockBefore = read(consumer, 'sync-standards.lock');
      write(up, 'managed/new.txt', 'new\n');
      write(up, 'managed/b.txt', 'changed\n');
      if (parentLink) {
        symlinkSync(victimRoot, join(consumer, 'new-managed'));
        write(up, 'new-managed/new.txt', 'new\n');
      } else {
        symlinkSync(
          join(victimRoot, 'missing.txt'),
          join(consumer, 'managed/new.txt'),
        );
      }

      const result = sync(up, consumer);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('must not be a symbolic link');
      expect(read(consumer, 'managed/b.txt')).toBe('beta\n');
      expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
      expect(existsSync(join(victimRoot, 'missing.txt'))).toBe(false);
      expect(existsSync(join(victimRoot, 'new.txt'))).toBe(false);
    }
  });

  it('rejects a consumer parent symlink before delete or prune', () => {
    const up = buildUpstream([...STD_PATHS, 'legacy']);
    write(up, 'legacy/nested/old.txt', 'old\n');
    const { consumer } = initConsumer(up);
    const victimRoot = mkTmp('sync-victim-');
    write(victimRoot, 'nested/old.txt', 'external\n');
    const lockBefore = read(consumer, 'sync-standards.lock');
    rmSync(join(up, 'legacy'), { recursive: true });
    write(
      up,
      'sync-standards.json',
      JSON.stringify({
        upstream: up,
        seedDir: 'template',
        syncPolicyContractVersion: SYNC_POLICY_CONTRACT_VERSION,
        paths: STD_PATHS,
      }),
    );
    rmSync(join(consumer, 'legacy'), { recursive: true });
    symlinkSync(victimRoot, join(consumer, 'legacy'));
    write(up, 'managed/a.txt', 'changed\n');

    const result = sync(up, consumer);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must not be a symbolic link');
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
    expect(read(victimRoot, 'nested/old.txt')).toBe('external\n');
  });
});

describe('consumer init and check filesystem boundary', () => {
  it('rejects a lock destination symlink before a managed update', () => {
    const up = buildUpstream();
    const { consumer } = initConsumer(up);
    const victimRoot = mkTmp('sync-victim-');
    write(victimRoot, 'victim.txt', 'external\n');
    rmSync(join(consumer, 'sync-standards.lock'));
    symlinkSync(
      join(victimRoot, 'victim.txt'),
      join(consumer, 'sync-standards.lock'),
    );
    write(up, 'managed/a.txt', 'changed\n');

    const result = sync(up, consumer);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must not be a symbolic link');
    expect(read(consumer, 'managed/a.txt')).toBe('alpha\n');
    expect(read(victimRoot, 'victim.txt')).toBe('external\n');
  });

  it('rejects seed destination links before init writes managed files', () => {
    for (const parentLink of [false, true]) {
      const up = buildUpstream();
      const consumer = mkTmp('sync-cons-');
      const victimRoot = mkTmp('sync-victim-');
      write(victimRoot, 'victim.txt', 'external\n');
      if (parentLink) {
        rmSync(join(up, 'template/seed.txt'));
        write(up, 'template/config/seed.txt', 'seed\n');
        symlinkSync(victimRoot, join(consumer, 'config'));
      } else {
        symlinkSync(join(victimRoot, 'victim.txt'), join(consumer, 'seed.txt'));
      }

      const result = run(consumer, ['init', '--from', up, '--dir', consumer]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('must not be a symbolic link');
      expect(existsSync(join(consumer, 'managed/a.txt'))).toBe(false);
      expect(existsSync(join(consumer, 'sync-standards.lock'))).toBe(false);
      expect(read(victimRoot, 'victim.txt')).toBe('external\n');
    }
  });

  it('rejects managed file and parent symlinks during check', () => {
    for (const parentLink of [false, true]) {
      const up = buildUpstream();
      const { consumer } = initConsumer(up);
      const victimRoot = mkTmp('sync-victim-');
      write(victimRoot, 'a.txt', 'external\n');
      if (parentLink) {
        rmSync(join(consumer, 'managed'), { recursive: true });
        symlinkSync(victimRoot, join(consumer, 'managed'));
      } else {
        rmSync(join(consumer, 'managed/a.txt'));
        symlinkSync(join(victimRoot, 'a.txt'), join(consumer, 'managed/a.txt'));
      }

      const result = run(consumer, ['check', '--dir', consumer]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('must not be a symbolic link');
      expect(read(victimRoot, 'a.txt')).toBe('external\n');
    }
  });
});

describe('path safety', () => {
  it('rejects managed paths that escape the source repository', () => {
    const up = buildUpstream(['../outside']);
    const consumer = mkTmp('sync-cons-');
    const result = run(consumer, ['init', '--from', up, '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'managed path must be a normalized repository-relative path',
    );
  });
});

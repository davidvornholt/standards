// Black-box integration tests: drive the sync CLI as a subprocess against
// throwaway temp fixtures and assert its documented status/stdout/stderr.

import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { DEFAULT_SYNC_POLICY, SYNC_POLICY_FILE } from './sync-policy';

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
const SYNC_POLICY_CONTRACT_VERSION = 1;
const BARE_SYNC_STEP = /^\s+run: bun standards sync$/mu;

type RunResult = { stdout: string; stderr: string; status: number };
type Lock = {
  upstream: string;
  ref?: string;
  sha: string;
  files: Record<string, string>;
};
type RunOptions = {
  readonly engine?: string;
  readonly env?: Readonly<Record<string, string>>;
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
const read = (root: string, rel: string): string =>
  readFileSync(join(root, rel), 'utf8');
const readLock = (root: string): Lock =>
  JSON.parse(read(root, 'sync-standards.lock')) as Lock;
const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
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
    const stdout = execFileSync('bun', [options.engine ?? ENGINE, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...options.env },
    });
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
    expect(existsSync(join(consumer, 'packages/standards-cli'))).toBe(false);
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

describe('sync source compatibility', () => {
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
    const policyBefore = read(consumer, SYNC_POLICY_FILE);
    const lockBefore = read(consumer, 'sync-standards.lock');

    const dry = sync(url, consumer, ['--ref', 'refs/tags/v1', '--dry-run']);

    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('would update managed/a.txt');
    expect(read(consumer, 'managed/a.txt')).toBe('alpha v2\n');
    expect(read(consumer, SYNC_POLICY_FILE)).toBe(policyBefore);
    expect(read(consumer, 'sync-standards.lock')).toBe(lockBefore);
  });
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

describe('github', () => {
  const EmptySeam = JSON.stringify({
    repository: {},
    rulesets: [],
    environments: [],
  });
  const Canonical = JSON.stringify({
    repository: { allow_auto_merge: true },
    rulesets: [{ name: 'Protect main', target: 'branch' }],
    environments: [],
  });

  it('fails when the canonical declaration is missing', () => {
    const { consumer } = initConsumer(buildUpstream());
    const result = run(consumer, ['github', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('.github/settings.json not found');
  });

  it('fails closed when the origin remote cannot be resolved', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/settings.json', Canonical);
    write(consumer, '.github/settings.local.json', EmptySeam);
    const result = run(consumer, ['github', '--check', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'cannot determine the GitHub repository from the origin remote',
    );
  });

  it('apply also requires a resolvable origin remote', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/settings.json', Canonical);
    write(consumer, '.github/settings.local.json', EmptySeam);
    const result = run(consumer, ['github', '--apply', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'cannot determine the GitHub repository from the origin remote',
    );
  });

  it('check gates on the declaration once it is present', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/settings.json', Canonical);
    write(consumer, '.github/settings.local.json', EmptySeam);
    const result = run(consumer, ['check', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'cannot determine the GitHub repository from the origin remote',
    );
  });

  it('doctor requires the local seam once the declaration is synced', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/settings.json', Canonical);
    const result = run(consumer, ['doctor', '--dir', consumer]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('.github/settings.local.json must exist');
  });

  it('doctor rejects a seam that overrides canonical values', () => {
    const { consumer } = initConsumer(buildUpstream());
    write(consumer, '.github/settings.json', Canonical);
    write(
      consumer,
      '.github/settings.local.json',
      JSON.stringify({
        repository: { allow_auto_merge: false },
        rulesets: [{ name: 'Protect main' }],
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

import { afterEach, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { runDevEnv } from './dev-env';
import { parseBrokeredS3Reference } from './dev-env-brokered';

const roots: Array<string> = [];
const originalPath = process.env.PATH;
const executableMode = 0o755;
const pairKey = 'garage.development';
const allowlist = 'owner/source@garage:garage.development';
const pair = (value: string) => ({
  garage: {
    development: {
      access_key_id: `ACCESS_${value}`,
      secret_access_key: `SECRET_${value}`,
    },
  },
});
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'cross-repository-s3-'));
  roots.push(root);
  const consumer = join(root, 'consumer');
  const source = join(root, 'source');
  const bin = join(root, 'bin');
  for (const directory of [
    consumer,
    source,
    bin,
    join(consumer, 'apps/web'),
    join(consumer, 'config'),
    join(consumer, 'secrets'),
    join(source, 'secrets'),
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  execFileSync('git', ['init', '-q', consumer]);
  execFileSync('git', ['init', '-q', source]);
  execFileSync('git', [
    '-C',
    source,
    'remote',
    'add',
    'origin',
    'git@github.com:owner/source.git',
  ]);
  writeFileSync(join(consumer, '.gitignore'), '.env.local*\n');
  writeFileSync(join(consumer, 'apps/web/package.json'), '{}');
  writeFileSync(
    join(source, 'secrets/garage.yaml'),
    JSON.stringify(pair('ONE')),
  );
  writeFileSync(
    join(bin, 'sops'),
    `#!/bin/sh\nprintf '%s/%s\\n' "$PWD" "$4" >> '${root}/calls'\ncat "$4"\n`,
  );
  chmodSync(join(bin, 'sops'), executableMode);
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
  const reference = {
    brokeredS3: 'garage',
    key: pairKey,
    part: 'access_key_id',
    source: { repository: 'owner/source', checkout: '../source' },
  };
  const configure = (
    override: Record<string, unknown> = {},
    authorization: ReadonlyArray<string> = [allowlist],
  ) => {
    writeFileSync(
      join(consumer, 'config/dev.yaml'),
      JSON.stringify({
        apps: {
          web: {
            S3_ACCESS_KEY_ID: { ...reference, ...override },
            S3_SECRET_ACCESS_KEY: { ...reference, part: 'secret_access_key' },
          },
        },
      }),
    );
    writeFileSync(
      join(consumer, 'secrets/dev.yaml'),
      JSON.stringify({ brokeredReferences: authorization }),
    );
  };
  configure();
  const output = join(consumer, 'apps/web/.env.local');
  const sourceCalls = () =>
    existsSync(join(root, 'calls'))
      ? readFileSync(join(root, 'calls'), 'utf8')
          .split('\n')
          .filter((line) => line.startsWith(`${source}/`))
      : [];
  return { root, consumer, source, output, reference, configure, sourceCalls };
};
afterEach(() => {
  process.env.PATH = originalPath;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it('refreshes both generated values from one authorized encrypted owner after rotation', async () => {
  const f = fixture();
  expect(await runDevEnv(f.consumer)).toBe(true);
  expect(readFileSync(f.output, 'utf8')).toContain(
    'S3_ACCESS_KEY_ID=ACCESS_ONE',
  );
  expect(readFileSync(f.output, 'utf8')).toContain(
    'S3_SECRET_ACCESS_KEY=SECRET_ONE',
  );
  expect(f.sourceCalls()).toHaveLength(1);
  writeFileSync(
    join(f.source, 'secrets/garage.yaml'),
    JSON.stringify(pair('TWO')),
  );
  expect(await runDevEnv(f.consumer)).toBe(true);
  expect(readFileSync(f.output, 'utf8')).toContain(
    'S3_ACCESS_KEY_ID=ACCESS_TWO',
  );
  expect(readFileSync(f.output, 'utf8')).toContain(
    'S3_SECRET_ACCESS_KEY=SECRET_TWO',
  );
  expect(
    readFileSync(join(f.consumer, 'config/dev.yaml'), 'utf8'),
  ).not.toContain('ACCESS_TWO');
  expect(
    readFileSync(join(f.consumer, 'secrets/dev.yaml'), 'utf8'),
  ).not.toContain('SECRET_TWO');
});

it.each([
  'unauthorized',
  'wrong repository',
  'wrong key',
  'wrong target',
  'target escape',
  'source symlink',
  'target symlink',
] as const)(
  'rejects %s without reading any source or changing the prior environment',
  async (scenario) => {
    const f = fixture();
    writeFileSync(f.output, 'PRIOR=unchanged\n');
    if (scenario === 'unauthorized') {
      f.configure({}, []);
    }
    if (scenario === 'wrong repository') {
      execFileSync('git', [
        '-C',
        f.source,
        'remote',
        'set-url',
        'origin',
        'https://github.com/other/source.git',
      ]);
    }
    if (scenario === 'wrong key') {
      f.configure({ key: 'garage.other' });
    }
    if (scenario === 'wrong target') {
      f.configure({ brokeredS3: 'other' });
    }
    if (scenario === 'target escape') {
      f.configure({ brokeredS3: '../garage' });
    }
    if (scenario === 'source symlink') {
      symlinkSync(f.source, join(f.root, 'linked'));
      f.configure({ source: { ...f.reference.source, checkout: '../linked' } });
    }
    if (scenario === 'target symlink') {
      rmSync(join(f.source, 'secrets/garage.yaml'));
      writeFileSync(
        join(f.root, 'outside.yaml'),
        JSON.stringify(pair('OUTSIDE')),
      );
      symlinkSync(
        join(f.root, 'outside.yaml'),
        join(f.source, 'secrets/garage.yaml'),
      );
    }
    expect(await runDevEnv(f.consumer)).toBe(false);
    expect(f.sourceCalls()).toEqual([]);
    expect(readFileSync(f.output, 'utf8')).toBe('PRIOR=unchanged\n');
  },
);

it('rejects an authorized malformed pair without changing the generated environment', async () => {
  const f = fixture();
  writeFileSync(f.output, 'PRIOR=unchanged\n');
  writeFileSync(
    join(f.source, 'secrets/garage.yaml'),
    JSON.stringify({
      garage: { development: { access_key_id: 'INCOMPLETE' } },
    }),
  );
  expect(await runDevEnv(f.consumer)).toBe(false);
  expect(readFileSync(f.output, 'utf8')).toBe('PRIOR=unchanged\n');
});

it('validates the complete configuration before resolving otherwise authorized source references', async () => {
  const f = fixture();
  writeFileSync(f.output, 'PRIOR=unchanged\n');
  const config = JSON.parse(
    readFileSync(join(f.consumer, 'config/dev.yaml'), 'utf8'),
  );
  config.apps.missing = { VALUE: 'literal' };
  writeFileSync(join(f.consumer, 'config/dev.yaml'), JSON.stringify(config));
  expect(await runDevEnv(f.consumer)).toBe(false);
  expect(f.sourceCalls()).toEqual([]);
  expect(readFileSync(f.output, 'utf8')).toBe('PRIOR=unchanged\n');
});

it('rejects malformed and ambiguous source descriptors', () => {
  const f = fixture();
  for (const source of [
    null,
    {},
    { repository: '../source', checkout: '../source' },
    { ...f.reference.source, extra: true },
  ]) {
    expect(
      parseBrokeredS3Reference('probe', { ...f.reference, source }).ok,
    ).toBe(false);
  }
});

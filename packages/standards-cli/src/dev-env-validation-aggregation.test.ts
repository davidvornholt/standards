import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { runDevEnv } from './dev-env';

const EXECUTABLE_MODE = 0o755;
const originalPath = process.env.PATH;
const roots: Array<string> = [];

type AcquisitionFailure = 'config' | 'local' | 'secrets';

const configWithSchemaProblems = `invalid: {}
apps:
  ghost:
    PORT: "3000"
  web: []
`;
const localWithSchemaProblems = `invalid: {}
packages: []
`;
const secretsWithSchemaProblems = JSON.stringify({
  invalid: {},
  apps: { ghost: { secret: 'secret' }, web: [] },
});
const localIgnoreProblem =
  'config/dev.local.yaml is not gitignored; ignore it before generating dev env files';
const matrix: ReadonlyArray<
  readonly [AcquisitionFailure, ReadonlyArray<string>]
> = [
  [
    'config',
    [
      'config/dev.yaml must contain valid YAML',
      'secrets/dev.yaml top-level key "invalid" must be "apps" or "packages"',
      'secrets/dev.yaml "apps.web" must map env keys to string values',
      'config/dev.local.yaml top-level key "invalid" must be "apps" or "packages"',
      'config/dev.local.yaml "packages" must map workspace names to env objects',
      localIgnoreProblem,
    ],
  ],
  [
    'secrets',
    [
      'config/dev.yaml top-level key "invalid" must be "apps" or "packages"',
      'config/dev.yaml "apps.web" must map env keys to string values',
      'could not decrypt secrets/dev.yaml: decrypt failed',
      'config/dev.local.yaml top-level key "invalid" must be "apps" or "packages"',
      'config/dev.local.yaml "packages" must map workspace names to env objects',
      localIgnoreProblem,
    ],
  ],
  [
    'local',
    [
      'config/dev.yaml top-level key "invalid" must be "apps" or "packages"',
      'config/dev.yaml "apps.web" must map env keys to string values',
      'secrets/dev.yaml top-level key "invalid" must be "apps" or "packages"',
      'secrets/dev.yaml "apps.web" must map env keys to string values',
      'config/dev.local.yaml must contain valid YAML',
      localIgnoreProblem,
    ],
  ],
];

const fixture = (
  acquisitionFailure: AcquisitionFailure,
): { readonly consumer: string; readonly destination: string } => {
  const root = mkdtempSync(join(tmpdir(), 'dev-env-validation-matrix-'));
  roots.push(root);
  const consumer = join(root, 'consumer');
  execFileSync('git', ['init', '--quiet', consumer]);
  mkdirSync(join(consumer, 'apps/web'), { recursive: true });
  mkdirSync(join(consumer, 'config'), { recursive: true });
  mkdirSync(join(consumer, 'secrets'), { recursive: true });
  writeFileSync(join(consumer, '.gitignore'), '.env.local\n');
  writeFileSync(join(consumer, 'apps/web/package.json'), '{}\n');
  writeFileSync(
    join(consumer, 'config/dev.yaml'),
    acquisitionFailure === 'config'
      ? 'apps: [unterminated\n'
      : configWithSchemaProblems,
  );
  writeFileSync(
    join(consumer, 'config/dev.local.yaml'),
    acquisitionFailure === 'local'
      ? 'apps: [unterminated\n'
      : localWithSchemaProblems,
  );
  writeFileSync(join(consumer, 'secrets/dev.yaml'), 'encrypted\n');

  const bin = join(root, 'bin');
  mkdirSync(bin);
  const sops = join(bin, 'sops');
  writeFileSync(
    sops,
    acquisitionFailure === 'secrets'
      ? '#!/bin/sh\nprintf "decrypt failed" >&2\nexit 23\n'
      : `#!/bin/sh\nprintf '%s' '${secretsWithSchemaProblems}'\n`,
  );
  chmodSync(sops, EXECUTABLE_MODE);
  process.env.PATH = `${bin}:${originalPath ?? ''}`;

  const destination = join(consumer, 'apps/web/.env.local');
  writeFileSync(destination, 'existing-value\n');
  return { consumer, destination };
};

afterEach(() => {
  mock.restore();
  process.env.PATH = originalPath;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('dev env acquisition and schema validation aggregation', () => {
  it.each(
    matrix,
  )('reports every acquired layer schema when %s acquisition fails', async (acquisitionFailure, expectedProblems) => {
    const setup = fixture(acquisitionFailure);
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    const log = spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await runDevEnv(setup.consumer)).toBe(false);

    const reported = error.mock.calls.flat().join('\n');
    expect(reported).toContain('standards dev-env: 6 problem(s):');
    expect(
      expectedProblems.filter((problem) => !reported.includes(problem)),
    ).toEqual([]);
    expect(reported).not.toContain('apps/ghost/package.json');
    expect(readFileSync(setup.destination, 'utf8')).toBe('existing-value\n');
    expect(log).not.toHaveBeenCalled();
  });
});

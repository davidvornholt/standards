import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { parse } from 'yaml';
import {
  ACTUAL_UPSTREAM,
  cleanupTmpDirs,
  mkTmp,
  runProcess,
  write,
  yamlRunScript,
} from './cli-test-support';

const WORKFLOW = join(ACTUAL_UPSTREAM, '.github/workflows/standards.yml');
const REQUEST_STEP = 'Request stale cache publication';
const EXECUTABLE_MODE = 0o755;
const SHA_LENGTH = 40;
const SECONDS_PER_HOUR = 3600;
const MILLISECONDS_PER_SECOND = 1000;
const STALE_TURBO_HOURS = 48;
const REPOSITORY = 'owner/repo';
const REF = 'refs/heads/main';
const LOCK_HASH = 'd'.repeat(SHA_LENGTH);
const ENDPOINT_SEPARATOR = /[^A-Za-z0-9]/gu;
const DISPATCH = `POST repos/${REPOSITORY}/actions/workflows/standards.yml/dispatches ref=main\n`;
// GitHub serves cache lists in snake_case.
const field = { caches: 'actions_caches', createdAt: 'created_at' } as const;

const hoursAgo = (hours: number): string =>
  new Date(
    Date.now() - hours * SECONDS_PER_HOUR * MILLISECONDS_PER_SECOND,
  ).toISOString();

const cacheList = (keys: ReadonlyArray<string>, createdAt = hoursAgo(1)) => ({
  [field.caches]: keys.map((key) => ({ [field.createdAt]: createdAt, key })),
});

const cachesEndpoint = (prefix: string): string =>
  `repos/${REPOSITORY}/actions/caches?ref=${REF}&key=${prefix}&per_page=100`;

const currentCaches = (): Record<string, unknown> => ({
  [cachesEndpoint('bun-packages-v2-')]: cacheList([
    'bun-packages-v2-Linux-X64-old',
    `bun-packages-v2-Linux-X64-${LOCK_HASH}`,
  ]),
  [cachesEndpoint('playwright-v2-')]: cacheList([]),
  [cachesEndpoint('turbo-trusted-v2-')]: cacheList([
    'turbo-trusted-v2-Linux-X64-commit',
  ]),
});

// Serves cache lists from fixtures and records workflow dispatches.
const GH_STUB = `#!/usr/bin/env bash
set -euo pipefail
[ "$1" = api ] || exit 2
shift
method=GET
endpoint=
fields=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --paginate) ;;
    --method) method=$2; shift ;;
    -f) fields="$fields $2"; shift ;;
    -*) echo "unexpected gh flag $1" >&2; exit 2 ;;
    *) endpoint=$1 ;;
  esac
  shift
done
if [ "$method" = POST ]; then
  [ ! -f "$FIXTURE/refuse-dispatch" ] || { echo "HTTP 403: $endpoint" >&2; exit 1; }
  echo "POST $endpoint$fields" >> "$FIXTURE/dispatches"
  exit 0
fi
file="$FIXTURE/api/$(printf '%s' "$endpoint" | tr -c 'A-Za-z0-9' '_').json"
[ -f "$file" ] || { echo "HTTP 404: $endpoint" >&2; exit 1; }
cat "$file"
`;

const requestEnvironment = (): Record<string, string> => {
  const workflow = parse(readFileSync(WORKFLOW, 'utf8')) as {
    jobs: {
      reuse: { steps: Array<{ name?: string; env?: Record<string, string> }> };
    };
  };
  const env = workflow.jobs.reuse.steps.find(
    (step) => step.name === REQUEST_STEP,
  )?.env;
  if (env === undefined) {
    throw new Error(`${REQUEST_STEP} must declare its environment`);
  }
  return Object.fromEntries(
    Object.entries(env).filter(([, value]) => !value.includes('${{')),
  );
};

const request = (
  api: Record<string, unknown>,
  { lockHash = LOCK_HASH, refuseDispatch = false } = {},
) => {
  const fixture = mkTmp('standards-cache-publication-');
  for (const [endpoint, body] of Object.entries(api)) {
    write(
      fixture,
      `api/${endpoint.replace(ENDPOINT_SEPARATOR, '_')}.json`,
      JSON.stringify(body),
    );
  }
  if (refuseDispatch) {
    write(fixture, 'refuse-dispatch', '');
  }
  write(fixture, 'bin/gh', GH_STUB);
  chmodSync(join(fixture, 'bin/gh'), EXECUTABLE_MODE);
  const result = runProcess(
    'bash',
    fixture,
    ['-euo', 'pipefail', '-c', yamlRunScript(WORKFLOW, REQUEST_STEP)],
    {
      ...process.env,
      ...requestEnvironment(),
      ...Object.fromEntries([
        ['FIXTURE', fixture],
        ['LOCK_HASH', lockHash],
        ['PATH', `${join(fixture, 'bin')}:${process.env.PATH ?? ''}`],
        ['REF', REF],
        ['REPOSITORY', REPOSITORY],
      ]),
    },
  );
  const dispatchesPath = join(fixture, 'dispatches');
  return {
    dispatches: existsSync(dispatchesPath)
      ? readFileSync(dispatchesPath, 'utf8')
      : '',
    status: result.status,
  };
};

const without = (
  api: Record<string, unknown>,
  endpoint: string,
): Record<string, unknown> =>
  Object.fromEntries(Object.entries(api).filter(([key]) => key !== endpoint));

afterEach(cleanupTmpDirs);

describe('stale cache publication request', () => {
  it('requests nothing while every trusted snapshot is current', () => {
    expect(request(currentCaches())).toEqual({ dispatches: '', status: 0 });
  });

  it('accepts Playwright snapshots for the current lock', () => {
    expect(
      request({
        ...currentCaches(),
        [cachesEndpoint('playwright-v2-')]: cacheList([
          `playwright-v2-Linux-X64-${LOCK_HASH}`,
        ]),
      }),
    ).toEqual({ dispatches: '', status: 0 });
  });

  it.each([
    [
      'no Bun snapshot for the current lock',
      {
        [cachesEndpoint('bun-packages-v2-')]: cacheList([
          'bun-packages-v2-Linux-X64-old',
        ]),
      },
    ],
    [
      'Playwright snapshots only for another lock',
      {
        [cachesEndpoint('playwright-v2-')]: cacheList([
          'playwright-v2-Linux-X64-old',
        ]),
      },
    ],
    [
      'no Turbo snapshot',
      { [cachesEndpoint('turbo-trusted-v2-')]: cacheList([]) },
    ],
    [
      'a stale Turbo snapshot',
      {
        [cachesEndpoint('turbo-trusted-v2-')]: cacheList(
          ['turbo-trusted-v2-Linux-X64-commit'],
          hoursAgo(STALE_TURBO_HOURS),
        ),
      },
    ],
  ])('dispatches one main gate run for %s', (_label, overrides) => {
    expect(request({ ...currentCaches(), ...overrides })).toEqual({
      dispatches: DISPATCH,
      status: 0,
    });
  });
});

describe('stale cache publication request errors', () => {
  it('fails without dispatching when a cache lookup fails', () => {
    const result = request(
      without(currentCaches(), cachesEndpoint('turbo-trusted-v2-')),
    );
    expect(result).toEqual({ dispatches: '', status: 1 });
  });

  it('fails without dispatching when the lockfile hash is missing', () => {
    expect(request(currentCaches(), { lockHash: '' })).toEqual({
      dispatches: '',
      status: 1,
    });
  });

  it('fails when GitHub refuses the dispatch', () => {
    const result = request(
      {
        ...currentCaches(),
        [cachesEndpoint('turbo-trusted-v2-')]: cacheList([]),
      },
      { refuseDispatch: true },
    );
    expect(result.status).not.toBe(0);
  });
});

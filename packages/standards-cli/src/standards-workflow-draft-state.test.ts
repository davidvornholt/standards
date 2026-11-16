import { afterEach, describe, expect, it } from 'bun:test';
import process from 'node:process';
import { cleanupTmpDirs } from './cli-test-support';
import { type Json, runStepWithApi } from './standards-workflow-test-support';

const STATE_STEP = 'Decide whether this draft run gates its head';
const SHA_LENGTH = 40;
const PR_NUMBER = 7;
const RUN_ID = 200;
const OLDER_RUN_ID = 199;
const NEWER_RUN_ID = 201;
const REPOSITORY = 'owner/repo';
const HEAD = 'b'.repeat(SHA_LENGTH);
const NEWER_HEAD = 'c'.repeat(SHA_LENGTH);

const endpoints = {
  pull: `repos/${REPOSITORY}/pulls/${PR_NUMBER}`,
  runs: `repos/${REPOSITORY}/actions/workflows/standards.yml/runs?head_sha=${HEAD}&event=pull_request&per_page=100`,
};

const api = ({
  draft = false,
  head = HEAD,
  runIds = [RUN_ID],
}: {
  readonly draft?: boolean;
  readonly head?: string;
  readonly runIds?: ReadonlyArray<number>;
} = {}): Record<string, Json> => ({
  [endpoints.pull]: { draft, head: { sha: head } },
  // GitHub lists the newest run first.
  [endpoints.runs]: {
    workflowRuns: runIds
      .toSorted((left, right) => right - left)
      .map((id) => ({
        id,
      })),
  },
});

const decide = (responses: Record<string, Json>) =>
  runStepWithApi(STATE_STEP, responses, {
    ...process.env,
    ...Object.fromEntries([
      ['HEAD_SHA', HEAD],
      ['PR_NUMBER', String(PR_NUMBER)],
      ['REPOSITORY', REPOSITORY],
      ['RUN_ID', String(RUN_ID)],
    ]),
  });

const without = (
  responses: Record<string, Json>,
  endpoint: string,
): Record<string, Json> =>
  Object.fromEntries(
    Object.entries(responses).filter(([key]) => key !== endpoint),
  );

afterEach(cleanupTmpDirs);

describe('a draft run whose pull request was marked ready', () => {
  // GitHub created this draft run after the ready run, so the merge box
  // shows only this run.
  it('gates its head when the ready run is older', () => {
    expect(decide(api({ runIds: [OLDER_RUN_ID, RUN_ID] }))).toEqual({
      output: 'gate=true\n',
      status: 0,
    });
  });

  // GitHub started the ready run on the previous head, so this draft run is
  // the only run on its head.
  it('gates its head when no ready run exists on it', () => {
    expect(decide(api())).toEqual({ output: 'gate=true\n', status: 0 });
  });

  it('skips when a newer run reports the checks of its head', () => {
    expect(decide(api({ runIds: [RUN_ID, NEWER_RUN_ID] }))).toEqual({
      output: 'gate=false\n',
      status: 0,
    });
  });

  it('skips when the pull request has a newer head', () => {
    expect(decide(api({ head: NEWER_HEAD }))).toEqual({
      output: 'gate=false\n',
      status: 0,
    });
  });
});

describe('a draft run whose pull request is still a draft', () => {
  it('skips', () => {
    expect(decide(api({ draft: true }))).toEqual({
      output: 'gate=false\n',
      status: 0,
    });
  });
});

describe('draft run lookup errors', () => {
  it.each(['pull', 'runs'] as const)(
    'fails without deciding when the %s lookup fails',
    (endpoint) => {
      const result = decide(without(api(), endpoints[endpoint]));
      expect(result.output).toBe('');
      expect(result.status).not.toBe(0);
    },
  );
});

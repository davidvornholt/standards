import { describe, expect, it } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parsePollerConfig } from './poller-config';

const CONFIG_DIR = '/etc/standards-poller';

const validConfig = (): Record<string, unknown> => ({
  repos: ['owner/repo'],
  model: 'gpt-5.6-sol',
  reasoningEffort: 'high',
});

const DEFAULT_STALE_CLAIM_HOURS = 6;
const DEFAULT_RUN_TIMEOUT_MINUTES = 240;

describe('parsePollerConfig', () => {
  it('accepts a minimal config and fills defaults', () => {
    const { config, problems } = parsePollerConfig(validConfig(), CONFIG_DIR);
    expect(problems).toEqual([]);
    expect(config?.maxJobsPerTick).toBe(1);
    expect(config?.staleClaimHours).toBe(DEFAULT_STALE_CLAIM_HOURS);
    expect(config?.runTimeoutMinutes).toBe(DEFAULT_RUN_TIMEOUT_MINUTES);
    expect(config?.extraCodexArgs).toEqual([]);
    expect(config?.cacheDir).toBe(
      join(homedir(), '.cache', 'standards-poller'),
    );
  });

  it('rejects a stale sweep shorter than the run timeout', () => {
    const { config, problems } = parsePollerConfig(
      { ...validConfig(), staleClaimHours: 4, runTimeoutMinutes: 240 },
      CONFIG_DIR,
    );
    expect(config).toBeNull();
    expect(problems).toEqual([
      'poller config "staleClaimHours" must exceed "runTimeoutMinutes": a shorter stale sweep would release the claim of a job that is still running',
    ]);
  });

  it('rejects unknown keys', () => {
    const { config, problems } = parsePollerConfig(
      { ...validConfig(), maxRunsPerDay: 3 },
      CONFIG_DIR,
    );
    expect(config).toBeNull();
    expect(problems).toEqual(['poller config has unknown key "maxRunsPerDay"']);
  });

  it('rejects an empty or malformed repo list', () => {
    expect(
      parsePollerConfig({ ...validConfig(), repos: [] }, CONFIG_DIR).problems,
    ).toContain('poller config "repos" must list at least one repository');
    expect(
      parsePollerConfig({ ...validConfig(), repos: ['not-a-repo'] }, CONFIG_DIR)
        .problems,
    ).toContain(
      'poller config "repos" entries must be "owner/repo": not-a-repo',
    );
    expect(
      parsePollerConfig({ ...validConfig(), repos: ['a/b', 'a/b'] }, CONFIG_DIR)
        .problems,
    ).toContain('poller config "repos" entries must be unique');
  });

  it('accepts at most twelve watched repositories', () => {
    const repos = Array.from(
      { length: 12 },
      (_, index) => `owner/repo-${index + 1}`,
    );
    expect(
      parsePollerConfig({ ...validConfig(), repos }, CONFIG_DIR),
    ).toMatchObject({ config: { repos }, problems: [] });
  });

  it('rejects a thirteenth watched repository with migration guidance', () => {
    const repos = Array.from(
      { length: 13 },
      (_, index) => `owner/repo-${index + 1}`,
    );
    expect(
      parsePollerConfig({ ...validConfig(), repos }, CONFIG_DIR).problems,
    ).toEqual([
      'poller config "repos" supports at most 12 repositories at the one-minute polling cadence; reduce the list or split it across pollers with independent GitHub API budgets',
    ]);
  });

  it('requires an explicit model and reasoning effort', () => {
    const { config, problems } = parsePollerConfig(
      { repos: ['owner/repo'] },
      CONFIG_DIR,
    );
    expect(config).toBeNull();
    expect(problems).toHaveLength(2);
  });

  it('rejects non-positive numeric fields', () => {
    const { problems } = parsePollerConfig(
      { ...validConfig(), maxJobsPerTick: 0 },
      CONFIG_DIR,
    );
    expect(problems).toEqual([
      'poller config "maxJobsPerTick" must be a positive integer',
    ]);
  });

  it('resolves a relative cacheDir against the config directory', () => {
    const { config } = parsePollerConfig(
      { ...validConfig(), cacheDir: 'cache' },
      CONFIG_DIR,
    );
    expect(config?.cacheDir).toBe(join(CONFIG_DIR, 'cache'));
  });

  it('expands a home-relative cacheDir', () => {
    const { config } = parsePollerConfig(
      { ...validConfig(), cacheDir: '~/poller-cache' },
      CONFIG_DIR,
    );
    expect(config?.cacheDir).toBe(join(homedir(), 'poller-cache'));
  });

  it('rejects a non-object config', () => {
    expect(parsePollerConfig('nope', CONFIG_DIR).problems).toEqual([
      'poller config must be a JSON object',
    ]);
  });
});

describe('parsePollerConfig problem aggregation', () => {
  it('reports type and capacity problems for an oversized mixed array', () => {
    const repos: ReadonlyArray<unknown> = [
      ...Array.from({ length: 12 }, (_, index) => `owner/repo-${index + 1}`),
      null,
    ];
    expect(
      parsePollerConfig({ ...validConfig(), repos }, CONFIG_DIR).problems,
    ).toEqual([
      'poller config "repos" supports at most 12 repositories at the one-minute polling cadence; reduce the list or split it across pollers with independent GitHub API budgets',
      'poller config "repos" must be a string array',
    ]);
  });
});

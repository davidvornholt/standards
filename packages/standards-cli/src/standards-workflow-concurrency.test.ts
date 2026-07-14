import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { YAML: BunYaml } = await import('bun');
const root = join(import.meta.dir, '../../..');
const workflow = BunYaml.parse(
  readFileSync(join(root, '.github/workflows/standards.yml'), 'utf8'),
) as {
  readonly concurrency: Readonly<Record<string, unknown>>;
  readonly jobs: {
    readonly check: {
      readonly concurrency: Readonly<Record<string, unknown>>;
      readonly name: string;
    };
  };
};
const settings = JSON.parse(
  readFileSync(join(root, '.github/settings.json'), 'utf8'),
) as Readonly<Record<string, unknown>>;
const property = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): unknown => Reflect.get(record, key) as unknown;
const protection = property(settings, 'default_branch_protection') as Readonly<
  Record<string, unknown>
>;
const requiredChecks = property(protection, 'required_status_checks') as {
  readonly checks: ReadonlyArray<{ readonly context: string }>;
};
const githubExpression = (value: string): string => `$${`{{ ${value} }}`}`;

describe('canonical quality workflow identity and queues', () => {
  it('cancels superseded PRs without replacing distinct push runs', () => {
    expect(workflow.concurrency).toEqual({
      group: `${githubExpression('github.workflow')}-${githubExpression("github.event_name == 'pull_request' && github.ref || github.sha")}`,
      'cancel-in-progress': githubExpression(
        "github.event_name == 'pull_request'",
      ),
    });
    expect(workflow.jobs.check.concurrency).toEqual({
      group: `${githubExpression('github.workflow')}-${githubExpression("github.event_name == 'push' && github.ref || github.run_id")}`,
      queue: 'max',
    });
  });

  it('keeps the required check identity exclusive to pull requests', () => {
    expect(workflow.jobs.check.name).toBe(
      githubExpression(
        "github.event_name == 'pull_request' && 'check' || 'main-check'",
      ),
    );
    expect(requiredChecks.checks.map(({ context }) => context)).toContain(
      'check',
    );
  });
});

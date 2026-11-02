import { afterEach, describe, expect, it } from 'bun:test';
import { collectStructureProblems } from './structure-check';
import {
  buildConsumer,
  CI_SOPS_METADATA_YAML,
  cleanupStructureTmps,
  writeInto as write,
} from './structure-test-support';

afterEach(cleanupStructureTmps);

const removeBrokerCredentials = (consumer: string): void => {
  write(consumer, 'secrets/ci.yaml', CI_SOPS_METADATA_YAML);
  write(consumer, 'secrets/ci.example.yaml', '{}\n');
};

const BROKER_REASON =
  'the synced Standards sync workflow mints a branch token with Contents write and Workflows write plus a pull request token with Contents read and Pull requests write, and the synced Standards sync and Standards auto-merge workflows mint a merge token with Contents write, Pull requests write, and Workflows write from ci.broker_app; provision it with "bun standards creds add github --dest ci:ci.broker_app"';
const BROKER_PROBLEMS = [
  `secrets/ci.yaml: missing required key "ci.broker_app.client_id" — ${BROKER_REASON}`,
  `secrets/ci.yaml: missing required key "ci.broker_app.private_key" — ${BROKER_REASON}`,
];

describe('broker credential policy', () => {
  it('requires broker credentials while automatic sync uses the workflow', async () => {
    const consumer = buildConsumer();
    removeBrokerCredentials(consumer);
    const problems = await collectStructureProblems(consumer, 'consumer');
    for (const problem of BROKER_PROBLEMS) {
      expect(problems).toContain(problem);
    }
  });

  // Standards auto-merge still merges Dependabot updates with the broker App
  // when the repository opts out of automatic sync.
  it('requires broker credentials when automatic sync is disabled', async () => {
    const consumer = buildConsumer();
    removeBrokerCredentials(consumer);
    write(
      consumer,
      'sync-standards.local.json',
      JSON.stringify({ autoSync: false }),
    );
    expect(await collectStructureProblems(consumer, 'consumer')).toEqual(
      BROKER_PROBLEMS,
    );
  });
});

import { afterEach, describe, expect, it } from 'bun:test';
import { collectStructureProblems } from './structure-check';
import {
  buildConsumer,
  CI_SOPS_METADATA_YAML,
  cleanupStructureTmps,
  FAKE_ENC,
  writeInto as write,
} from './structure-test-support';

afterEach(cleanupStructureTmps);

const removeBrokerCredentials = (consumer: string): void => {
  write(
    consumer,
    'secrets/ci.yaml',
    `ci:\n  ntfy_topic_url: ${FAKE_ENC}\n${CI_SOPS_METADATA_YAML}`,
  );
  write(
    consumer,
    'secrets/ci.example.yaml',
    'ci:\n  ntfy_topic_url: placeholder\n',
  );
};

describe('automatic sync credential policy', () => {
  it('requires broker credentials while automatic sync uses the workflow', async () => {
    const consumer = buildConsumer();
    removeBrokerCredentials(consumer);
    const problems = await collectStructureProblems(consumer, 'consumer');
    expect(problems).toContain(
      'secrets/ci.yaml: missing required key "ci.broker_app.app_id" — the synced Standards sync workflow mints a branch token with Contents write and Workflows write plus a pull request token with Contents read and Pull requests write from ci.broker_app; provision it with "bun standards creds add github --dest ci:ci.broker_app"',
    );
    expect(problems).toContain(
      'secrets/ci.yaml: missing required key "ci.broker_app.private_key" — the synced Standards sync workflow mints a branch token with Contents write and Workflows write plus a pull request token with Contents read and Pull requests write from ci.broker_app; provision it with "bun standards creds add github --dest ci:ci.broker_app"',
    );
  });

  it('does not require broker credentials when automatic sync is disabled', async () => {
    const consumer = buildConsumer();
    removeBrokerCredentials(consumer);
    write(
      consumer,
      'sync-standards.local.json',
      JSON.stringify({ autoSync: false }),
    );
    expect(await collectStructureProblems(consumer, 'consumer')).toEqual([]);
  });
});

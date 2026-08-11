import { afterEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
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

const AUTOMATION = {
  environment: 'standards-sync',
  ageKeySecret: 'STANDARDS_SYNC_SOPS_AGE_KEY',
  secretTarget: 'standards-sync',
  brokerAppKey: 'github.repository_app',
} as const;

const NOTIFICATIONS = {
  environment: 'notifications',
  ageKeySecret: 'NOTIFICATIONS_SOPS_AGE_KEY',
  secretTarget: 'notifications',
  topicKey: 'ntfy_topic_url',
} as const;

const writeAutomationCredentials = (consumer: string): void => {
  write(
    consumer,
    'secrets/standards-sync.yaml',
    `ci:\n  github:\n    repository_app:\n      app_id: ${FAKE_ENC}\n      private_key: ${FAKE_ENC}\n${CI_SOPS_METADATA_YAML}`,
  );
  write(
    consumer,
    'secrets/standards-sync.example.yaml',
    'ci:\n  github:\n    repository_app:\n      app_id: placeholder\n      private_key: placeholder\n',
  );
};

const writeNotificationCredentials = (consumer: string): void => {
  write(
    consumer,
    'secrets/notifications.yaml',
    `ci:\n  ntfy_topic_url: ${FAKE_ENC}\n${CI_SOPS_METADATA_YAML}`,
  );
  write(
    consumer,
    'secrets/notifications.example.yaml',
    'ci:\n  ntfy_topic_url: https://ntfy.sh/replace-with-a-random-unguessable-topic\n',
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

  it('validates opted-in broker credentials in their purpose-specific target', async () => {
    const consumer = buildConsumer();
    removeBrokerCredentials(consumer);
    write(
      consumer,
      'sync-standards.local.json',
      JSON.stringify({ automation: AUTOMATION }),
    );
    writeAutomationCredentials(consumer);

    expect(await collectStructureProblems(consumer, 'consumer')).toEqual([]);
  });

  it('fails closed when an opted-in target or example is absent', async () => {
    const consumer = buildConsumer();
    removeBrokerCredentials(consumer);
    write(
      consumer,
      'sync-standards.local.json',
      JSON.stringify({ automation: AUTOMATION }),
    );

    const problems = await collectStructureProblems(consumer, 'consumer');
    expect(problems).toContain(
      'secrets/standards-sync.yaml: must exist as a SOPS-encrypted file; sync-standards.local.json selects it for environment-scoped Standards sync automation',
    );
    expect(problems).toContain(
      'secrets/standards-sync.example.yaml: must exist and mirror the key shape of secrets/standards-sync.yaml with plaintext placeholders',
    );
  });

  it('requires both broker leaves at the configured dotted path', async () => {
    const consumer = buildConsumer();
    removeBrokerCredentials(consumer);
    write(
      consumer,
      'sync-standards.local.json',
      JSON.stringify({ automation: AUTOMATION }),
    );
    writeAutomationCredentials(consumer);
    write(
      consumer,
      'secrets/standards-sync.yaml',
      `ci:\n  github:\n    repository_app:\n      app_id: ${FAKE_ENC}\n${CI_SOPS_METADATA_YAML}`,
    );

    expect(await collectStructureProblems(consumer, 'consumer')).toContain(
      'secrets/standards-sync.yaml: missing required key "ci.github.repository_app.private_key" — the environment-scoped Standards sync workflow mints its current-repository tokens from ci.github.repository_app; provision it with "bun standards creds add github --dest standards-sync:ci.github.repository_app"',
    );
  });

  it('allows both legacy CI files to retire when both workflows are isolated', async () => {
    const consumer = buildConsumer();
    rmSync(join(consumer, 'secrets/ci.yaml'));
    rmSync(join(consumer, 'secrets/ci.example.yaml'));
    write(
      consumer,
      'sync-standards.local.json',
      JSON.stringify({
        automation: AUTOMATION,
        notifications: NOTIFICATIONS,
      }),
    );
    writeAutomationCredentials(consumer);
    writeNotificationCredentials(consumer);

    expect(await collectStructureProblems(consumer, 'consumer')).toEqual([]);
  });

  it('requires the configured notification topic in its isolated target', async () => {
    const consumer = buildConsumer();
    write(
      consumer,
      'sync-standards.local.json',
      JSON.stringify({ notifications: NOTIFICATIONS }),
    );

    const problems = await collectStructureProblems(consumer, 'consumer');
    expect(problems).toContain(
      'secrets/notifications.yaml: must exist as a SOPS-encrypted file; sync-standards.local.json selects it for environment-scoped pause notifications',
    );
    expect(problems).toContain(
      'secrets/notifications.example.yaml: must exist and mirror the key shape of secrets/notifications.yaml with plaintext placeholders',
    );
  });
});

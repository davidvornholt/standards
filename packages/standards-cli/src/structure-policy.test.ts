import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isolationPolicySha256 } from './automation-proof';
import { collectStructureProblems } from './structure-check';
import {
  buildConsumer,
  CI_SOPS_METADATA_YAML,
  cleanupStructureTmps,
  FAKE_ENC,
  writeInto as write,
} from './structure-test-support';
import { parseSyncPolicy } from './sync-policy';

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
  ageRecipient: 'age1automationrecipient000000000000000000000000000000000000',
} as const;

const NOTIFICATIONS = {
  environment: 'notifications',
  ageKeySecret: 'NOTIFICATIONS_SOPS_AGE_KEY',
  secretTarget: 'notifications',
  topicKey: 'ntfy_topic_url',
  ageRecipient: 'age1notificationrecipient00000000000000000000000000000000000',
} as const;
const MILLISECONDS_PER_SECOND = 1000;
const COMMIT_SHA_LENGTH = 40;
const LEGACY_RECIPIENT =
  'age1legacyrecipient00000000000000000000000000000000000000';
const RECOVERY_RECIPIENT =
  'age1personalrecovery0000000000000000000000000000000000000';
const PLANE_EVIDENCE = {
  automation: {
    environmentId: 10,
    branchPolicyId: 20,
    runId: 30,
    workflowId: 40,
    deploymentId: 50,
    workflowPath: '.github/workflows/standards-sync.yml',
    event: 'schedule',
  },
  notifications: {
    environmentId: 11,
    branchPolicyId: 21,
    runId: 31,
    workflowId: 41,
    deploymentId: 51,
    workflowPath: '.github/workflows/notify-pause.yml',
    event: 'issues',
  },
} as const;
const NON_AGE_METADATA_BLOCKS = [
  [
    'azure_kv',
    '    azure_kv:\n        - vault_url: https://vault.example\n          name: key\n          version: one\n          created_at: "2026-08-05T00:00:00Z"\n          enc: recipient-envelope',
  ],
  ['azure_keyvault', '    azure_keyvault:\n        - test'],
  [
    'gcp_kms',
    '    gcp_kms:\n        - resource_id: projects/p/locations/l/keyRings/r/cryptoKeys/k\n          created_at: "2026-08-05T00:00:00Z"\n          enc: recipient-envelope',
  ],
  [
    'hc_vault',
    '    hc_vault:\n        - vault_address: https://vault.example\n          engine_path: transit\n          key_name: key\n          created_at: "2026-08-05T00:00:00Z"\n          enc: recipient-envelope',
  ],
  ['hc_vault_transit_uri', '    hc_vault_transit_uri:\n        - test'],
  [
    'kms',
    '    kms:\n        - arn: arn:aws:kms:eu-west-1:123:key/test\n          created_at: "2026-08-05T00:00:00Z"\n          enc: recipient-envelope',
  ],
  [
    'pgp',
    '    pgp:\n        - created_at: "2026-08-05T00:00:00Z"\n          enc: recipient-envelope\n          fp: ABCDEF',
  ],
] as const;

const metadataFor = (...recipients: ReadonlyArray<string>): string =>
  CI_SOPS_METADATA_YAML.replace(
    '        - recipient: age1test\n          enc: test-recipient-envelope',
    recipients
      .map(
        (recipient) =>
          `        - recipient: ${recipient}\n          enc: test-recipient-envelope`,
      )
      .join('\n'),
  );

const metadataWithNonAgeSource = (
  recipient: string,
  sourceBlock: string,
): string =>
  metadataFor(recipient).replace(
    '    version: 3.9.0',
    `${sourceBlock}\n    version: 3.9.0`,
  );

const writeIsolationRules = (consumer: string): void => {
  write(
    consumer,
    '.sops.yaml',
    `creation_rules:\n  - path_regex: secrets/standards-sync\\.yaml$\n    key_groups:\n      - age:\n          - ${AUTOMATION.ageRecipient}\n  - path_regex: secrets/notifications\\.yaml$\n    key_groups:\n      - age:\n          - ${NOTIFICATIONS.ageRecipient}\n`,
  );
};

const writeIsolationProof = (
  consumer: string,
  value: Record<string, unknown>,
  deliveries = false,
): void => {
  const policy = parseSyncPolicy(value);
  const observedAt = new Date(
    Math.floor(Date.now() / MILLISECONDS_PER_SECOND) * MILLISECONDS_PER_SECOND,
  )
    .toISOString()
    .replace('.000Z', 'Z');
  execFileSync('git', ['init', '--quiet', consumer]);
  execFileSync('git', [
    '-C',
    consumer,
    'remote',
    'add',
    'origin',
    'git@github.com:owner/repo.git',
  ]);
  const plane = (
    name: 'automation' | 'notifications',
    selected: NonNullable<
      typeof policy.automation | typeof policy.notifications
    >,
  ) => {
    const evidence = PLANE_EVIDENCE[name];
    return {
      environmentId: evidence.environmentId,
      environment: selected.environment,
      branchPolicyIds: [evidence.branchPolicyId],
      secretName: selected.ageKeySecret,
      repositorySecretAbsent: true,
      organizationSecret: 'not-applicable',
      ageRecipient: selected.ageRecipient,
      ...(deliveries
        ? {
            delivery: {
              runId: evidence.runId,
              workflowId: evidence.workflowId,
              workflowPath: evidence.workflowPath,
              headSha: 'a'.repeat(COMMIT_SHA_LENGTH),
              headRef: 'main',
              event: evidence.event,
              environment: selected.environment,
              deploymentId: evidence.deploymentId,
              completedAt: observedAt,
              conclusion: 'success',
            },
          }
        : {}),
    };
  };
  write(
    consumer,
    'sync-standards.environment-proof.json',
    JSON.stringify({
      version: 1,
      repository: {
        id: 1,
        ownerId: 2,
        fullName: 'owner/repo',
        private: false,
        defaultBranch: 'main',
        ownerType: 'User',
        ownerPlan: 'not-required',
        capability: 'public-repository',
      },
      policySha256: isolationPolicySha256(policy),
      capabilityObservedAt: observedAt,
      observedAt,
      legacyAgeRecipients: [LEGACY_RECIPIENT],
      planes: {
        ...(policy.automation === undefined
          ? {}
          : { automation: plane('automation', policy.automation) }),
        ...(policy.notifications === undefined
          ? {}
          : { notifications: plane('notifications', policy.notifications) }),
      },
    }),
  );
};

const writeAutomationCredentials = (consumer: string): void => {
  write(
    consumer,
    'secrets/standards-sync.yaml',
    `ci:\n  github:\n    repository_app:\n      app_id: ${FAKE_ENC}\n      private_key: ${FAKE_ENC}\n${metadataFor(AUTOMATION.ageRecipient)}`,
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
    `ci:\n  ntfy_topic_url: ${FAKE_ENC}\n${metadataFor(NOTIFICATIONS.ageRecipient)}`,
  );
  write(
    consumer,
    'secrets/notifications.example.yaml',
    'ci:\n  ntfy_topic_url: https://ntfy.sh/replace-with-a-random-unguessable-topic\n',
  );
};

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: These cases share one complete structure fixture and collectively specify the migration state machine.
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
      JSON.stringify({ automation: AUTOMATION, recoveryAgeRecipients: [] }),
    );
    writeIsolationProof(consumer, {
      automation: AUTOMATION,
      recoveryAgeRecipients: [],
    });
    writeAutomationCredentials(consumer);
    writeIsolationRules(consumer);

    expect(await collectStructureProblems(consumer, 'consumer')).toEqual([]);
  });

  it('fails closed when an opted-in target or example is absent', async () => {
    const consumer = buildConsumer();
    removeBrokerCredentials(consumer);
    write(
      consumer,
      'sync-standards.local.json',
      JSON.stringify({ automation: AUTOMATION, recoveryAgeRecipients: [] }),
    );
    writeIsolationProof(consumer, {
      automation: AUTOMATION,
      recoveryAgeRecipients: [],
    });

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
      JSON.stringify({ automation: AUTOMATION, recoveryAgeRecipients: [] }),
    );
    writeIsolationProof(consumer, {
      automation: AUTOMATION,
      recoveryAgeRecipients: [],
    });
    writeAutomationCredentials(consumer);
    writeIsolationRules(consumer);
    write(
      consumer,
      'secrets/standards-sync.yaml',
      `ci:\n  github:\n    repository_app:\n      app_id: ${FAKE_ENC}\n${metadataFor(AUTOMATION.ageRecipient)}`,
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
        recoveryAgeRecipients: [],
      }),
    );
    writeAutomationCredentials(consumer);
    writeNotificationCredentials(consumer);
    writeIsolationRules(consumer);
    writeIsolationProof(
      consumer,
      {
        automation: AUTOMATION,
        notifications: NOTIFICATIONS,
        recoveryAgeRecipients: [],
      },
      true,
    );

    expect(await collectStructureProblems(consumer, 'consumer')).toEqual([]);
  });

  it('requires the configured notification topic in its isolated target', async () => {
    const consumer = buildConsumer();
    write(
      consumer,
      'sync-standards.local.json',
      JSON.stringify({
        notifications: NOTIFICATIONS,
        recoveryAgeRecipients: [],
      }),
    );
    writeIsolationProof(consumer, {
      notifications: NOTIFICATIONS,
      recoveryAgeRecipients: [],
    });
    writeIsolationRules(consumer);

    const problems = await collectStructureProblems(consumer, 'consumer');
    expect(problems).toContain(
      'secrets/notifications.yaml: must exist as a SOPS-encrypted file; sync-standards.local.json selects it for environment-scoped pause notifications',
    );
    expect(problems).toContain(
      'secrets/notifications.example.yaml: must exist and mirror the key shape of secrets/notifications.yaml with plaintext placeholders',
    );
  });

  it('rejects a retained plaintext legacy CI target after full isolation', async () => {
    const consumer = buildConsumer();
    write(
      consumer,
      'sync-standards.local.json',
      JSON.stringify({
        automation: AUTOMATION,
        notifications: NOTIFICATIONS,
        recoveryAgeRecipients: [],
      }),
    );
    writeAutomationCredentials(consumer);
    writeNotificationCredentials(consumer);
    writeIsolationRules(consumer);
    writeIsolationProof(consumer, {
      automation: AUTOMATION,
      notifications: NOTIFICATIONS,
      recoveryAgeRecipients: [],
    });
    write(
      consumer,
      'secrets/ci.yaml',
      `ci:\n  retired: plaintext\n${CI_SOPS_METADATA_YAML}`,
    );
    write(consumer, 'secrets/ci.example.yaml', 'ci:\n  retired: placeholder\n');

    expect(await collectStructureProblems(consumer, 'consumer')).toContain(
      'secrets/ci.yaml: value at "ci.retired" is not a complete SOPS-encrypted value; plaintext secret values must never be committed',
    );
  });

  it('rejects a purpose target shared with the legacy recipient', async () => {
    const consumer = buildConsumer();
    write(
      consumer,
      'sync-standards.local.json',
      JSON.stringify({ automation: AUTOMATION, recoveryAgeRecipients: [] }),
    );
    writeIsolationProof(consumer, {
      automation: AUTOMATION,
      recoveryAgeRecipients: [],
    });
    writeAutomationCredentials(consumer);
    writeIsolationRules(consumer);
    write(
      consumer,
      'secrets/standards-sync.yaml',
      `ci:\n  github:\n    repository_app:\n      app_id: ${FAKE_ENC}\n      private_key: ${FAKE_ENC}\n${CI_SOPS_METADATA_YAML}`,
    );

    expect(await collectStructureProblems(consumer, 'consumer')).toContain(
      'secrets/standards-sync.yaml: SOPS metadata age recipients must be exactly the plane recipient plus declared recovery recipients',
    );
  });

  it('rejects a full consumer whose purpose plane reuses its legacy recipient', async () => {
    const consumer = buildConsumer();
    const automation = { ...AUTOMATION, ageRecipient: LEGACY_RECIPIENT };
    const policy = { automation, recoveryAgeRecipients: [] };
    write(consumer, 'sync-standards.local.json', JSON.stringify(policy));
    writeIsolationProof(consumer, policy);
    write(
      consumer,
      'secrets/standards-sync.yaml',
      `ci:\n  github:\n    repository_app:\n      app_id: ${FAKE_ENC}\n      private_key: ${FAKE_ENC}\n${metadataFor(LEGACY_RECIPIENT)}`,
    );
    write(
      consumer,
      'secrets/standards-sync.example.yaml',
      'ci:\n  github:\n    repository_app:\n      app_id: placeholder\n      private_key: placeholder\n',
    );
    write(
      consumer,
      '.sops.yaml',
      `creation_rules:\n  - path_regex: secrets/standards-sync\\.yaml$\n    key_groups:\n      - age:\n          - ${LEGACY_RECIPIENT}\n`,
    );

    expect(await collectStructureProblems(consumer, 'consumer')).toContain(
      'sync-standards.environment-proof.json: automation age recipient reuses a legacy CI decryptor identity',
    );
  });

  it.each(
    NON_AGE_METADATA_BLOCKS,
  )('rejects %s from purpose-target SOPS metadata', async (source, sourceBlock) => {
    const consumer = buildConsumer();
    const policy = { automation: AUTOMATION, recoveryAgeRecipients: [] };
    write(consumer, 'sync-standards.local.json', JSON.stringify(policy));
    writeIsolationProof(consumer, policy);
    writeAutomationCredentials(consumer);
    writeIsolationRules(consumer);
    write(
      consumer,
      'secrets/standards-sync.yaml',
      `ci:\n  github:\n    repository_app:\n      app_id: ${FAKE_ENC}\n      private_key: ${FAKE_ENC}\n${metadataWithNonAgeSource(AUTOMATION.ageRecipient, sourceBlock)}`,
    );

    expect(await collectStructureProblems(consumer, 'consumer')).toContain(
      `secrets/standards-sync.yaml: SOPS metadata must use age decryptors only; remove non-age source(s): ${source}`,
    );
  });

  it.each(
    NON_AGE_METADATA_BLOCKS,
  )('rejects %s from a purpose-target creation rule', async (source) => {
    const consumer = buildConsumer();
    const policy = { automation: AUTOMATION, recoveryAgeRecipients: [] };
    write(consumer, 'sync-standards.local.json', JSON.stringify(policy));
    writeIsolationProof(consumer, policy);
    writeAutomationCredentials(consumer);
    write(
      consumer,
      '.sops.yaml',
      `creation_rules:\n  - path_regex: secrets/standards-sync\\.yaml$\n    key_groups:\n      - age:\n          - ${AUTOMATION.ageRecipient}\n        ${source}:\n          - test\n`,
    );

    expect(await collectStructureProblems(consumer, 'consumer')).toContain(
      `.sops.yaml: creation rule for secrets/standards-sync.yaml must use age decryptors only; remove non-age source(s): ${source}`,
    );
  });

  it('allows only explicitly declared personal recovery recipients beside a plane identity', async () => {
    const consumer = buildConsumer();
    const policy = {
      automation: AUTOMATION,
      recoveryAgeRecipients: [RECOVERY_RECIPIENT],
    };
    write(consumer, 'sync-standards.local.json', JSON.stringify(policy));
    writeIsolationProof(consumer, policy);
    write(
      consumer,
      'secrets/standards-sync.yaml',
      `ci:\n  github:\n    repository_app:\n      app_id: ${FAKE_ENC}\n      private_key: ${FAKE_ENC}\n${metadataFor(AUTOMATION.ageRecipient, RECOVERY_RECIPIENT)}`,
    );
    write(
      consumer,
      'secrets/standards-sync.example.yaml',
      'ci:\n  github:\n    repository_app:\n      app_id: placeholder\n      private_key: placeholder\n',
    );
    write(
      consumer,
      '.sops.yaml',
      `creation_rules:\n  - path_regex: secrets/standards-sync\\.yaml$\n    key_groups:\n      - age:\n          - ${AUTOMATION.ageRecipient}\n          - ${RECOVERY_RECIPIENT}\n`,
    );

    expect(await collectStructureProblems(consumer, 'consumer')).toEqual([]);
  });

  it('rejects unknown persisted-proof fields instead of trusting self-asserted evidence', async () => {
    const consumer = buildConsumer();
    const policy = { automation: AUTOMATION, recoveryAgeRecipients: [] };
    write(consumer, 'sync-standards.local.json', JSON.stringify(policy));
    writeIsolationProof(consumer, policy);
    writeAutomationCredentials(consumer);
    writeIsolationRules(consumer);
    const proof = JSON.parse(
      readFileSync(
        join(consumer, 'sync-standards.environment-proof.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    proof.assertedByContributor = true;
    write(
      consumer,
      'sync-standards.environment-proof.json',
      JSON.stringify(proof),
    );

    expect(await collectStructureProblems(consumer, 'consumer')).toContain(
      'sync-standards.environment-proof.json "root" has invalid fields',
    );
  });

  it('rejects organization proof without observable absent organization secret scope', async () => {
    const consumer = buildConsumer();
    const policy = { automation: AUTOMATION, recoveryAgeRecipients: [] };
    write(consumer, 'sync-standards.local.json', JSON.stringify(policy));
    writeIsolationProof(consumer, policy);
    writeAutomationCredentials(consumer);
    writeIsolationRules(consumer);
    const proof = JSON.parse(
      readFileSync(
        join(consumer, 'sync-standards.environment-proof.json'),
        'utf8',
      ),
    ) as {
      repository: Record<string, unknown>;
      planes: { automation: Record<string, unknown> };
    };
    proof.repository.ownerType = 'Organization';
    proof.repository.private = true;
    proof.repository.ownerPlan = 'team';
    proof.repository.capability = 'paid-private-owner';
    proof.planes.automation.organizationSecret = 'not-applicable';
    write(
      consumer,
      'sync-standards.environment-proof.json',
      JSON.stringify(proof),
    );

    expect(await collectStructureProblems(consumer, 'consumer')).toContain(
      'sync-standards.environment-proof.json has invalid organization secret-scope evidence',
    );
  });
});

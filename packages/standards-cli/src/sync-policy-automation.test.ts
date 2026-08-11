import { afterEach, describe, expect, it } from 'bun:test';
import { cleanupTmpDirs, mkTmp, write } from './cli-test-support';
import { readSyncPolicy } from './sync-policy';
import { CONTROL_CHARACTER_CORPUS } from './sync-policy-control-corpus';

afterEach(cleanupTmpDirs);

const readPolicy = (policy: unknown) => {
  const consumer = mkTmp('sync-automation-policy-');
  write(consumer, 'sync-standards.local.json', JSON.stringify(policy));
  return readSyncPolicy(consumer);
};

const AUTOMATION = {
  environment: 'standards-sync',
  ageKeySecret: 'STANDARDS_SYNC_SOPS_AGE_KEY',
  secretTarget: 'standards-sync',
  brokerAppKey: 'github.repository_app',
  ageRecipient: 'age1automationrecipient000000000000000000000000000000000000',
} as const;

describe('Standards sync automation policy', () => {
  it.each(
    CONTROL_CHARACTER_CORPUS,
  )('rejects %s in ref and environment before a shell boundary', async (_label, control) => {
    await expect(readPolicy({ ref: `main${control}` })).rejects.toThrow(
      'without control characters',
    );
    await expect(
      readPolicy({
        automation: {
          ...AUTOMATION,
          environment: `standards${control}-sync`,
        },
        recoveryAgeRecipients: [],
      }),
    ).rejects.toThrow('without control characters');
  });

  it('preserves the legacy automation contract when the seam is absent', async () => {
    await expect(readPolicy({ ref: 'main' })).resolves.toEqual({
      autoSync: undefined,
      ref: 'main',
      automation: undefined,
      notifications: undefined,
      recoveryAgeRecipients: undefined,
    });
  });

  it('accepts one complete purpose-scoped automation contract', async () => {
    await expect(
      readPolicy({
        autoSync: true,
        automation: AUTOMATION,
        recoveryAgeRecipients: [],
      }),
    ).resolves.toEqual({
      autoSync: true,
      ref: undefined,
      automation: AUTOMATION,
      notifications: undefined,
      recoveryAgeRecipients: [],
    });
  });

  it.each([
    [
      'a partial object',
      { environment: AUTOMATION.environment },
      'requires environment, ageKeySecret, secretTarget, brokerAppKey, and ageRecipient together',
    ],
    [
      'an unexpected field',
      { ...AUTOMATION, branch: 'main' },
      'contains unsupported field(s): branch',
    ],
    [
      'a traversal target',
      { ...AUTOMATION, secretTarget: '../ci' },
      'must be a purpose-specific kebab-case target basename other than ci',
    ],
    [
      'the legacy generic target',
      { ...AUTOMATION, secretTarget: 'ci' },
      'must be a purpose-specific kebab-case target basename other than ci',
    ],
    [
      'the generic legacy broker key',
      { ...AUTOMATION, brokerAppKey: 'broker_app' },
      'must be a purpose-scoped lowercase dotted path with at least two segments',
    ],
    [
      'a traversal-like broker key',
      { ...AUTOMATION, brokerAppKey: 'github...repository_app' },
      'must be a purpose-scoped lowercase dotted path with at least two segments',
    ],
    [
      'a reserved GitHub secret name',
      { ...AUTOMATION, ageKeySecret: 'GITHUB_SOPS_AGE_KEY' },
      'must be an uppercase GitHub secret name that does not start with GITHUB_',
    ],
  ] as const)('rejects %s', async (_label, automation, reason) => {
    await expect(
      readPolicy({ automation, recoveryAgeRecipients: [] }),
    ).rejects.toThrow(reason);
  });
});

const NOTIFICATIONS = {
  environment: 'notifications',
  ageKeySecret: 'NOTIFICATIONS_SOPS_AGE_KEY',
  secretTarget: 'notifications',
  topicKey: 'ntfy_topic_url',
  ageRecipient: 'age1notificationrecipient00000000000000000000000000000000000',
} as const;

describe('notification isolation policy', () => {
  it('accepts a complete purpose-scoped notification contract', async () => {
    await expect(
      readPolicy({ notifications: NOTIFICATIONS, recoveryAgeRecipients: [] }),
    ).resolves.toEqual({
      autoSync: undefined,
      ref: undefined,
      automation: undefined,
      notifications: NOTIFICATIONS,
      recoveryAgeRecipients: [],
    });
  });

  it.each([
    [
      'a partial object',
      { environment: NOTIFICATIONS.environment },
      'requires environment, ageKeySecret, secretTarget, topicKey, and ageRecipient together',
    ],
    [
      'a traversal target',
      { ...NOTIFICATIONS, secretTarget: '../../ci' },
      'must be a purpose-specific kebab-case target basename other than ci',
    ],
    [
      'a traversal-like topic key',
      { ...NOTIFICATIONS, topicKey: '../ntfy_topic_url' },
      'must be a lowercase dotted key path',
    ],
  ] as const)('rejects %s', async (_label, notifications, reason) => {
    await expect(
      readPolicy({ notifications, recoveryAgeRecipients: [] }),
    ).rejects.toThrow(reason);
  });

  it('requires separate credential planes for sync and notifications', async () => {
    await expect(
      readPolicy({
        automation: AUTOMATION,
        notifications: {
          ...NOTIFICATIONS,
          ageKeySecret: AUTOMATION.ageKeySecret,
        },
        recoveryAgeRecipients: [],
      }),
    ).rejects.toThrow(
      'automation and notifications must use distinct environments, age key secrets, secret targets, and age recipients',
    );
  });

  it('compares GitHub environment names case-insensitively', async () => {
    await expect(
      readPolicy({
        automation: AUTOMATION,
        notifications: {
          ...NOTIFICATIONS,
          environment: 'Standards-Sync',
        },
        recoveryAgeRecipients: [],
      }),
    ).rejects.toThrow(
      'automation and notifications must use distinct environments, age key secrets, secret targets, and age recipients',
    );
  });
});

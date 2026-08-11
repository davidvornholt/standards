import { isNonEmptyString, isRecord } from './github-settings-parse';

export const SYNC_POLICY_FILE = 'sync-standards.local.json';
const LINE_BREAK = /[\r\n]/u;
const AGE_KEY_SECRET = /^(?!GITHUB_)[A-Z_][A-Z0-9_]*$/u;
const SECRET_TARGET = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const BROKER_APP_KEY = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;
const TOPIC_KEY = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u;

export type SyncAutomationPolicy = {
  readonly environment: string;
  readonly ageKeySecret: string;
  readonly secretTarget: string;
  readonly brokerAppKey: string;
};

export type NotificationPolicy = {
  readonly environment: string;
  readonly ageKeySecret: string;
  readonly secretTarget: string;
  readonly topicKey: string;
};

const parseEnvironment = (value: unknown, field: string): string => {
  if (!isNonEmptyString(value) || LINE_BREAK.test(value)) {
    throw new Error(
      `${SYNC_POLICY_FILE} "${field}" must be a non-empty single-line string`,
    );
  }
  return value;
};

const parseAgeKeySecret = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !AGE_KEY_SECRET.test(value)) {
    throw new Error(
      `${SYNC_POLICY_FILE} "${field}" must be an uppercase GitHub secret name that does not start with GITHUB_`,
    );
  }
  return value;
};

const parseSecretTarget = (value: unknown, field: string): string => {
  if (
    typeof value !== 'string' ||
    !SECRET_TARGET.test(value) ||
    value === 'ci'
  ) {
    throw new Error(
      `${SYNC_POLICY_FILE} "${field}" must be a purpose-specific kebab-case target basename other than ci`,
    );
  }
  return value;
};

const validateShape = (
  parsed: Record<string, unknown>,
  name: string,
  fields: ReadonlyArray<string>,
): void => {
  const unsupported = Object.keys(parsed).filter(
    (field) => !fields.includes(field),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `${SYNC_POLICY_FILE} "${name}" contains unsupported field(s): ${unsupported.join(', ')}`,
    );
  }
  const missing = fields.filter((field) => parsed[field] === undefined);
  if (missing.length > 0) {
    const required = `${fields.slice(0, -1).join(', ')}, and ${fields.at(-1)}`;
    throw new Error(
      `${SYNC_POLICY_FILE} "${name}" requires ${required} together; missing: ${missing.join(', ')}`,
    );
  }
};

const parseAutomation = (parsed: unknown): SyncAutomationPolicy => {
  if (!isRecord(parsed)) {
    throw new Error(`${SYNC_POLICY_FILE} "automation" must be an object`);
  }
  validateShape(parsed, 'automation', [
    'environment',
    'ageKeySecret',
    'secretTarget',
    'brokerAppKey',
  ]);
  if (
    typeof parsed.brokerAppKey !== 'string' ||
    !BROKER_APP_KEY.test(parsed.brokerAppKey)
  ) {
    throw new Error(
      `${SYNC_POLICY_FILE} "automation.brokerAppKey" must be a purpose-scoped lowercase dotted path with at least two segments`,
    );
  }
  return {
    environment: parseEnvironment(parsed.environment, 'automation.environment'),
    ageKeySecret: parseAgeKeySecret(
      parsed.ageKeySecret,
      'automation.ageKeySecret',
    ),
    secretTarget: parseSecretTarget(
      parsed.secretTarget,
      'automation.secretTarget',
    ),
    brokerAppKey: parsed.brokerAppKey,
  };
};

const parseNotifications = (parsed: unknown): NotificationPolicy => {
  if (!isRecord(parsed)) {
    throw new Error(`${SYNC_POLICY_FILE} "notifications" must be an object`);
  }
  validateShape(parsed, 'notifications', [
    'environment',
    'ageKeySecret',
    'secretTarget',
    'topicKey',
  ]);
  if (typeof parsed.topicKey !== 'string' || !TOPIC_KEY.test(parsed.topicKey)) {
    throw new Error(
      `${SYNC_POLICY_FILE} "notifications.topicKey" must be a lowercase dotted key path`,
    );
  }
  return {
    environment: parseEnvironment(
      parsed.environment,
      'notifications.environment',
    ),
    ageKeySecret: parseAgeKeySecret(
      parsed.ageKeySecret,
      'notifications.ageKeySecret',
    ),
    secretTarget: parseSecretTarget(
      parsed.secretTarget,
      'notifications.secretTarget',
    ),
    topicKey: parsed.topicKey,
  };
};

export const parseIsolationFields = (
  parsed: Record<string, unknown>,
): {
  readonly automation?: SyncAutomationPolicy;
  readonly notifications?: NotificationPolicy;
} => {
  const automation =
    parsed.automation === undefined
      ? undefined
      : parseAutomation(parsed.automation);
  const notifications =
    parsed.notifications === undefined
      ? undefined
      : parseNotifications(parsed.notifications);
  if (
    automation !== undefined &&
    notifications !== undefined &&
    (automation.environment.toLowerCase() ===
      notifications.environment.toLowerCase() ||
      automation.ageKeySecret === notifications.ageKeySecret ||
      automation.secretTarget === notifications.secretTarget)
  ) {
    throw new Error(
      `${SYNC_POLICY_FILE} automation and notifications must use distinct environments, age key secrets, and secret targets`,
    );
  }
  return { automation, notifications };
};

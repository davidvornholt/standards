import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from './github-settings-parse';
import type { SyncPolicy } from './sync-policy';
import { hasControlCharacter } from './sync-policy-isolation';

export const AUTOMATION_PROOF_FILE = 'sync-standards.environment-proof.json';
const DAYS_PER_PROOF_WINDOW = 30;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const POLICY_SHA = /^[0-9a-f]{64}$/u;
const AGE_RECIPIENT = /^age1[0-9a-z]{20,}$/u;
export const AUTOMATION_PROOF_MAX_AGE_MS =
  DAYS_PER_PROOF_WINDOW *
  HOURS_PER_DAY *
  MINUTES_PER_HOUR *
  SECONDS_PER_MINUTE *
  MILLISECONDS_PER_SECOND;

export type DeliveryProof = {
  readonly runId: number;
  readonly workflowId: number;
  readonly workflowPath: string;
  readonly headSha: string;
  readonly headRef: 'main';
  readonly event: string;
  readonly environment: string;
  readonly deploymentId: number;
  readonly completedAt: string;
  readonly conclusion: 'success';
};

export type EnvironmentPlaneProof = {
  readonly environmentId: number;
  readonly environment: string;
  readonly branchPolicyIds: ReadonlyArray<number>;
  readonly secretName: string;
  readonly repositorySecretAbsent: true;
  readonly organizationSecret: 'absent' | 'not-applicable' | 'unobservable';
  readonly ageRecipient: string;
  readonly delivery?: DeliveryProof;
};

export type AutomationProof = {
  readonly version: 1;
  readonly repository: {
    readonly id: number;
    readonly ownerId: number;
    readonly fullName: string;
    readonly private: boolean;
    readonly defaultBranch: 'main';
    readonly ownerType: 'Organization' | 'User';
    readonly ownerPlan: string;
    readonly capability: 'paid-private-owner' | 'public-repository';
  };
  readonly policySha256: string;
  readonly capabilityObservedAt: string;
  readonly observedAt: string;
  readonly legacyAgeRecipients: ReadonlyArray<string>;
  readonly planes: {
    readonly automation?: EnvironmentPlaneProof;
    readonly notifications?: EnvironmentPlaneProof;
  };
};

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
};

export const isolationPolicySha256 = (policy: SyncPolicy): string =>
  createHash('sha256')
    .update(
      JSON.stringify(
        canonical({
          automation: policy.automation ?? null,
          notifications: policy.notifications ?? null,
          recoveryAgeRecipients: policy.recoveryAgeRecipients ?? null,
        }),
      ),
    )
    .digest('hex');

const exactKeys = (
  value: Record<string, unknown>,
  expected: ReadonlyArray<string>,
  label: string,
): void => {
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${AUTOMATION_PROOF_FILE} "${label}" has invalid fields`);
  }
};

const timestamp = (value: unknown, label: string): string => {
  if (
    typeof value !== 'string' ||
    hasControlCharacter(value) ||
    !TIMESTAMP.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${AUTOMATION_PROOF_FILE} "${label}" is invalid`);
  }
  return value;
};

const positiveInteger = (value: unknown, label: string): number => {
  if (
    !(typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
  ) {
    throw new Error(`${AUTOMATION_PROOF_FILE} "${label}" is invalid`);
  }
  return value;
};

const parseDelivery = (value: unknown, label: string): DeliveryProof => {
  if (!isRecord(value)) {
    throw new Error(`${AUTOMATION_PROOF_FILE} "${label}" is invalid`);
  }
  exactKeys(
    value,
    [
      'runId',
      'workflowId',
      'workflowPath',
      'headSha',
      'headRef',
      'event',
      'environment',
      'deploymentId',
      'completedAt',
      'conclusion',
    ],
    label,
  );
  if (
    typeof value.workflowPath !== 'string' ||
    typeof value.event !== 'string' ||
    typeof value.environment !== 'string' ||
    [value.workflowPath, value.event, value.environment].some((item) =>
      hasControlCharacter(item),
    ) ||
    typeof value.headSha !== 'string' ||
    !COMMIT_SHA.test(value.headSha) ||
    value.headRef !== 'main' ||
    value.conclusion !== 'success'
  ) {
    throw new Error(`${AUTOMATION_PROOF_FILE} "${label}" is invalid`);
  }
  return {
    runId: positiveInteger(value.runId, `${label}.runId`),
    workflowId: positiveInteger(value.workflowId, `${label}.workflowId`),
    workflowPath: value.workflowPath,
    headSha: value.headSha,
    headRef: 'main',
    event: value.event,
    environment: value.environment,
    deploymentId: positiveInteger(value.deploymentId, `${label}.deploymentId`),
    completedAt: timestamp(value.completedAt, `${label}.completedAt`),
    conclusion: 'success',
  };
};

const parsePlane = (value: unknown, label: string): EnvironmentPlaneProof => {
  if (!isRecord(value)) {
    throw new Error(`${AUTOMATION_PROOF_FILE} "${label}" is invalid`);
  }
  const expected = [
    'environmentId',
    'environment',
    'branchPolicyIds',
    'secretName',
    'repositorySecretAbsent',
    'organizationSecret',
    'ageRecipient',
    ...(value.delivery === undefined ? [] : ['delivery']),
  ];
  exactKeys(value, expected, label);
  if (
    typeof value.environment !== 'string' ||
    hasControlCharacter(value.environment) ||
    typeof value.secretName !== 'string' ||
    hasControlCharacter(value.secretName) ||
    typeof value.ageRecipient !== 'string' ||
    hasControlCharacter(value.ageRecipient) ||
    value.repositorySecretAbsent !== true ||
    !['absent', 'not-applicable', 'unobservable'].includes(
      String(value.organizationSecret),
    ) ||
    !Array.isArray(value.branchPolicyIds) ||
    value.branchPolicyIds.length !== 1
  ) {
    throw new Error(`${AUTOMATION_PROOF_FILE} "${label}" is invalid`);
  }
  return {
    environmentId: positiveInteger(
      value.environmentId,
      `${label}.environmentId`,
    ),
    environment: value.environment,
    branchPolicyIds: [
      positiveInteger(value.branchPolicyIds[0], `${label}.branchPolicyIds[0]`),
    ],
    secretName: value.secretName,
    repositorySecretAbsent: true,
    organizationSecret:
      value.organizationSecret as EnvironmentPlaneProof['organizationSecret'],
    ageRecipient: value.ageRecipient,
    ...(value.delivery === undefined
      ? {}
      : { delivery: parseDelivery(value.delivery, `${label}.delivery`) }),
  };
};

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: The strict persisted-proof schema is clearest as one exact-field parser that returns only fully validated evidence.
export const parseAutomationProof = (value: unknown): AutomationProof => {
  if (!isRecord(value)) {
    throw new Error(`${AUTOMATION_PROOF_FILE} must be a JSON object`);
  }
  exactKeys(
    value,
    [
      'version',
      'repository',
      'policySha256',
      'capabilityObservedAt',
      'observedAt',
      'legacyAgeRecipients',
      'planes',
    ],
    'root',
  );
  if (
    value.version !== 1 ||
    !isRecord(value.repository) ||
    !isRecord(value.planes)
  ) {
    throw new Error(`${AUTOMATION_PROOF_FILE} has an unsupported shape`);
  }
  exactKeys(
    value.repository,
    [
      'id',
      'ownerId',
      'fullName',
      'private',
      'defaultBranch',
      'ownerType',
      'ownerPlan',
      'capability',
    ],
    'repository',
  );
  exactKeys(
    value.planes,
    [
      ...(value.planes.automation === undefined ? [] : ['automation']),
      ...(value.planes.notifications === undefined ? [] : ['notifications']),
    ],
    'planes',
  );
  if (
    typeof value.repository.fullName !== 'string' ||
    hasControlCharacter(value.repository.fullName) ||
    typeof value.repository.private !== 'boolean' ||
    value.repository.defaultBranch !== 'main' ||
    !['Organization', 'User'].includes(String(value.repository.ownerType)) ||
    typeof value.repository.ownerPlan !== 'string' ||
    hasControlCharacter(value.repository.ownerPlan) ||
    !['paid-private-owner', 'public-repository'].includes(
      String(value.repository.capability),
    ) ||
    typeof value.policySha256 !== 'string' ||
    !POLICY_SHA.test(value.policySha256) ||
    !Array.isArray(value.legacyAgeRecipients) ||
    !value.legacyAgeRecipients.every(
      (entry) => typeof entry === 'string' && AGE_RECIPIENT.test(entry),
    ) ||
    new Set(value.legacyAgeRecipients).size !==
      value.legacyAgeRecipients.length ||
    (value.repository.private === true
      ? value.repository.capability !== 'paid-private-owner' ||
        value.repository.ownerPlan === '' ||
        value.repository.ownerPlan.toLowerCase() === 'free'
      : value.repository.capability !== 'public-repository')
  ) {
    throw new Error(
      `${AUTOMATION_PROOF_FILE} has invalid repository or policy evidence`,
    );
  }
  return {
    version: 1,
    repository: {
      id: positiveInteger(value.repository.id, 'repository.id'),
      ownerId: positiveInteger(value.repository.ownerId, 'repository.ownerId'),
      fullName: value.repository.fullName,
      private: value.repository.private,
      defaultBranch: 'main',
      ownerType: value.repository.ownerType as 'Organization' | 'User',
      ownerPlan: value.repository.ownerPlan,
      capability: value.repository
        .capability as AutomationProof['repository']['capability'],
    },
    policySha256: value.policySha256,
    capabilityObservedAt: timestamp(
      value.capabilityObservedAt,
      'capabilityObservedAt',
    ),
    observedAt: timestamp(value.observedAt, 'observedAt'),
    legacyAgeRecipients: value.legacyAgeRecipients,
    planes: {
      ...(value.planes.automation === undefined
        ? {}
        : {
            automation: parsePlane(
              value.planes.automation,
              'planes.automation',
            ),
          }),
      ...(value.planes.notifications === undefined
        ? {}
        : {
            notifications: parsePlane(
              value.planes.notifications,
              'planes.notifications',
            ),
          }),
    },
  };
};

export const readAutomationProof = async (
  consumer: string,
): Promise<AutomationProof | null> => {
  const path = join(consumer, AUTOMATION_PROOF_FILE);
  if (!existsSync(path)) {
    return null;
  }
  return parseAutomationProof(
    JSON.parse(await readFile(path, 'utf8')) as unknown,
  );
};

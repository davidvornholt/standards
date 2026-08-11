import { existsSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AUTOMATION_PROOF_FILE, readAutomationProof } from './automation-proof';
import { automationProofProblems } from './automation-proof-validation';
import { isContainedPath } from './contained-path';
import { isRecord } from './github-settings-parse';
import {
  inspectExampleDocument,
  inspectSecretDocument,
  type RequiredSecretLeaf,
  secretShapeProblems,
} from './structure-secret-document';
import {
  sopsAgeRecipients,
  sopsNonAgeSources,
} from './structure-sops-envelope';
import { readSyncPolicy } from './sync-policy';
import { parseYaml } from './yaml-parse';

const CI_SECRETS = 'secrets/ci.yaml';
const CI_EXAMPLE = 'secrets/ci.example.yaml';
const BROKER_REASON =
  'the synced Standards sync workflow mints a branch token with Contents write and Workflows write plus a pull request token with Contents read and Pull requests write from ci.broker_app; provision it with "bun standards creds add github --dest ci:ci.broker_app"';
const NTFY_REQUIREMENT: RequiredSecretLeaf = {
  path: ['ci', 'ntfy_topic_url'],
  reason: 'the synced Notify pause workflow pushes to it',
};
const BROKER_REQUIREMENTS: ReadonlyArray<RequiredSecretLeaf> = [
  { path: ['ci', 'broker_app', 'app_id'], reason: BROKER_REASON },
  { path: ['ci', 'broker_app', 'private_key'], reason: BROKER_REASON },
];

type SecretPairContract = {
  readonly secretsRel: string;
  readonly exampleRel: string;
  readonly required: ReadonlyArray<RequiredSecretLeaf>;
  readonly missingSecrets: string;
  readonly missingExample: string;
  readonly expectedAgeRecipients?: ReadonlyArray<string>;
};

type ParsedMapping = {
  readonly mapping: Record<string, unknown> | null;
  readonly problems: ReadonlyArray<string>;
};

const parseMapping = async (
  consumer: string,
  rel: string,
  missingRequirement: string,
): Promise<ParsedMapping> => {
  const path = join(consumer, rel);
  const info = await lstat(path).catch(() => null);
  if (info === null) {
    return { mapping: null, problems: [missingRequirement] };
  }
  if (!isContainedPath(consumer, rel, 'file')) {
    return {
      mapping: null,
      problems: [
        `${rel}: must be a contained regular file; symlinked paths are not allowed`,
      ],
    };
  }
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) {
    return { mapping: null, problems: [`${rel}: could not be read`] };
  }
  const parsed = parseYaml(raw, rel);
  if (parsed.problem !== null) {
    return { mapping: null, problems: [parsed.problem] };
  }
  if (!isRecord(parsed.value)) {
    return { mapping: null, problems: [`${rel}: must be a YAML mapping`] };
  }
  return { mapping: parsed.value, problems: [] };
};

const requiredContracts = async (
  consumer: string,
): Promise<{
  readonly contracts: ReadonlyArray<SecretPairContract>;
  readonly problems: ReadonlyArray<string>;
}> => {
  try {
    const policy = await readSyncPolicy(consumer);
    const automatic = policy.autoSync !== false;
    const legacyBroker = automatic && policy.automation === undefined;
    const legacyNotification = policy.notifications === undefined;
    const contracts: Array<SecretPairContract> = [];
    const ciRequirements = [
      ...(legacyNotification ? [NTFY_REQUIREMENT] : []),
      ...(legacyBroker ? BROKER_REQUIREMENTS : []),
    ];
    const [ciSecretsInfo, ciExampleInfo] = await Promise.all([
      lstat(join(consumer, CI_SECRETS)).catch(() => null),
      lstat(join(consumer, CI_EXAMPLE)).catch(() => null),
    ]);
    if (
      ciRequirements.length > 0 ||
      ciSecretsInfo !== null ||
      ciExampleInfo !== null
    ) {
      contracts.push({
        secretsRel: CI_SECRETS,
        exampleRel: CI_EXAMPLE,
        required: ciRequirements,
        missingSecrets: `${CI_SECRETS}: must exist as a SOPS-encrypted file; the synced CI workflows read ci.ntfy_topic_url and, when automatic sync is enabled, ci.broker_app from it`,
        missingExample: `${CI_EXAMPLE}: must exist and mirror the key shape of ${CI_SECRETS} with plaintext placeholders`,
      });
    }
    if (automatic && policy.automation !== undefined) {
      const { brokerAppKey, secretTarget } = policy.automation;
      const secretsRel = `secrets/${secretTarget}.yaml`;
      const exampleRel = `secrets/${secretTarget}.example.yaml`;
      const basePath = ['ci', ...brokerAppKey.split('.')];
      const destination = `${secretTarget}:ci.${brokerAppKey}`;
      const reason = `the environment-scoped Standards sync workflow mints its current-repository tokens from ci.${brokerAppKey}; provision it with "bun standards creds add github --dest ${destination}"`;
      contracts.push({
        secretsRel,
        exampleRel,
        required: [
          { path: [...basePath, 'app_id'], reason },
          { path: [...basePath, 'private_key'], reason },
        ],
        missingSecrets: `${secretsRel}: must exist as a SOPS-encrypted file; sync-standards.local.json selects it for environment-scoped Standards sync automation`,
        missingExample: `${exampleRel}: must exist and mirror the key shape of ${secretsRel} with plaintext placeholders`,
        expectedAgeRecipients: [
          policy.automation.ageRecipient,
          ...(policy.recoveryAgeRecipients ?? []),
        ],
      });
    }
    if (policy.notifications !== undefined) {
      const { secretTarget, topicKey } = policy.notifications;
      const secretsRel = `secrets/${secretTarget}.yaml`;
      const exampleRel = `secrets/${secretTarget}.example.yaml`;
      contracts.push({
        secretsRel,
        exampleRel,
        required: [
          {
            path: ['ci', ...topicKey.split('.')],
            reason: 'the environment-scoped Notify pause workflow pushes to it',
          },
        ],
        missingSecrets: `${secretsRel}: must exist as a SOPS-encrypted file; sync-standards.local.json selects it for environment-scoped pause notifications`,
        missingExample: `${exampleRel}: must exist and mirror the key shape of ${secretsRel} with plaintext placeholders`,
        expectedAgeRecipients: [
          policy.notifications.ageRecipient,
          ...(policy.recoveryAgeRecipients ?? []),
        ],
      });
    }
    return { contracts, problems: [] };
  } catch (error) {
    return {
      contracts: [
        {
          secretsRel: CI_SECRETS,
          exampleRel: CI_EXAMPLE,
          required: [NTFY_REQUIREMENT, ...BROKER_REQUIREMENTS],
          missingSecrets: `${CI_SECRETS}: must exist as a SOPS-encrypted file; the synced CI workflows read ci.ntfy_topic_url and, when automatic sync is enabled, ci.broker_app from it`,
          missingExample: `${CI_EXAMPLE}: must exist and mirror the key shape of ${CI_SECRETS} with plaintext placeholders`,
        },
      ],
      problems: [error instanceof Error ? error.message : String(error)],
    };
  }
};

const sortedUnique = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(values)].sort();

const ruleAgeRecipients = (value: unknown): ReadonlyArray<string> => {
  if (!isRecord(value)) {
    return [];
  }
  const direct = Array.isArray(value.age)
    ? value.age.filter(
        (recipient): recipient is string => typeof recipient === 'string',
      )
    : [];
  const grouped = Array.isArray(value.key_groups)
    ? value.key_groups.flatMap((group) =>
        isRecord(group) && Array.isArray(group.age)
          ? group.age.filter(
              (recipient): recipient is string => typeof recipient === 'string',
            )
          : [],
      )
    : [];
  return [...direct, ...grouped];
};

const recipientProblems = (
  rel: string,
  actual: ReadonlyArray<string>,
  expected: ReadonlyArray<string>,
  source: string,
): ReadonlyArray<string> =>
  JSON.stringify(sortedUnique(actual)) ===
  JSON.stringify(sortedUnique(expected))
    ? []
    : [
        `${rel}: ${source} age recipients must be exactly the plane recipient plus declared recovery recipients`,
      ];

const nonAgeSourceProblems = (
  rel: string,
  actual: ReadonlyArray<string>,
  source: string,
): ReadonlyArray<string> =>
  actual.length === 0
    ? []
    : [
        `${rel}: ${source} must use age decryptors only; remove non-age source(s): ${actual.join(', ')}`,
      ];

const creationRuleRecipientProblems = async (
  consumer: string,
  contract: SecretPairContract,
): Promise<ReadonlyArray<string>> => {
  if (contract.expectedAgeRecipients === undefined) {
    return [];
  }
  const rel = '.sops.yaml';
  const raw = await readFile(join(consumer, rel), 'utf8').catch(() => null);
  if (raw === null) {
    return [`${rel}: must exist to bind the isolated SOPS target recipient`];
  }
  const parsed = parseYaml(raw, rel);
  if (parsed.problem !== null || !isRecord(parsed.value)) {
    return [parsed.problem ?? `${rel}: must be a YAML mapping`];
  }
  const rules = parsed.value.creation_rules;
  if (!Array.isArray(rules)) {
    return [`${rel}: creation_rules must select ${contract.secretsRel}`];
  }
  const matches = rules.filter((candidate) => {
    if (!isRecord(candidate) || typeof candidate.path_regex !== 'string') {
      return false;
    }
    try {
      return new RegExp(candidate.path_regex, 'u').test(contract.secretsRel);
    } catch {
      return false;
    }
  });
  if (matches.length !== 1 || !isRecord(matches[0])) {
    return [
      `${rel}: exactly one creation rule must match ${contract.secretsRel}`,
    ];
  }
  const [rule] = matches;
  return [
    ...nonAgeSourceProblems(
      rel,
      sopsNonAgeSources(rule),
      `creation rule for ${contract.secretsRel}`,
    ),
    ...recipientProblems(
      rel,
      ruleAgeRecipients(rule),
      contract.expectedAgeRecipients,
      `creation rule for ${contract.secretsRel}`,
    ),
  ];
};

const collectPairProblems = async (
  consumer: string,
  contract: SecretPairContract,
): Promise<ReadonlyArray<string>> => {
  const [secretsFile, exampleFile] = await Promise.all([
    parseMapping(consumer, contract.secretsRel, contract.missingSecrets),
    parseMapping(consumer, contract.exampleRel, contract.missingExample),
  ]);
  const secrets =
    secretsFile.mapping === null
      ? null
      : inspectSecretDocument(
          contract.secretsRel,
          secretsFile.mapping,
          contract.required,
        );
  const example =
    exampleFile.mapping === null
      ? null
      : inspectExampleDocument(contract.exampleRel, exampleFile.mapping);
  const recipientMetadataProblems =
    secretsFile.mapping === null || contract.expectedAgeRecipients === undefined
      ? []
      : recipientProblems(
          contract.secretsRel,
          sopsAgeRecipients(secretsFile.mapping.sops),
          contract.expectedAgeRecipients,
          'SOPS metadata',
        );
  const nonAgeMetadataProblems =
    secretsFile.mapping === null || contract.expectedAgeRecipients === undefined
      ? []
      : nonAgeSourceProblems(
          contract.secretsRel,
          sopsNonAgeSources(secretsFile.mapping.sops),
          'SOPS metadata',
        );
  return [
    ...secretsFile.problems,
    ...exampleFile.problems,
    ...(secrets === null ? [] : secrets.problems),
    ...(example === null ? [] : example.problems),
    ...recipientMetadataProblems,
    ...nonAgeMetadataProblems,
    ...(await creationRuleRecipientProblems(consumer, contract)),
    ...(secrets !== null && example !== null
      ? secretShapeProblems({
          secretsRel: contract.secretsRel,
          exampleRel: contract.exampleRel,
          secrets: secrets.leaves,
          example: example.leaves,
          required: contract.required,
        })
      : []),
  ];
};

export const collectCiSecretsProblems = async (
  consumer: string,
): Promise<ReadonlyArray<string>> => {
  const requirement = await requiredContracts(consumer);
  const policy = await readSyncPolicy(consumer).catch(() => null);
  const proofProblems = await readSyncPolicy(consumer)
    .then((selectedPolicy) => automationProofProblems(consumer, selectedPolicy))
    .catch(() => []);
  const contractProblems = await Promise.all(
    requirement.contracts.map((contract) =>
      collectPairProblems(consumer, contract),
    ),
  );
  const legacyRetirementProblems: Array<string> = [];
  if (
    policy !== null &&
    policy.automation !== undefined &&
    policy.notifications !== undefined &&
    !(
      existsSync(join(consumer, CI_SECRETS)) ||
      existsSync(join(consumer, CI_EXAMPLE))
    )
  ) {
    const proof = await readAutomationProof(consumer).catch(() => null);
    if (proof?.planes.notifications?.delivery === undefined) {
      legacyRetirementProblems.push(
        `${AUTOMATION_PROOF_FILE}: notification delivery proof is required before retiring secrets/ci.yaml`,
      );
    }
    if (
      policy.autoSync !== false &&
      proof?.planes.automation?.delivery === undefined
    ) {
      legacyRetirementProblems.push(
        `${AUTOMATION_PROOF_FILE}: automation delivery proof is required before retiring secrets/ci.yaml`,
      );
    }
  }
  return [
    ...requirement.problems,
    ...proofProblems,
    ...legacyRetirementProblems,
    ...contractProblems.flat(),
  ];
};

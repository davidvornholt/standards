import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isContainedPath } from './contained-path';
import { isRecord } from './github-settings-parse';
import {
  inspectExampleDocument,
  inspectSecretDocument,
  type RequiredSecretLeaf,
  secretShapeProblems,
} from './structure-secret-document';
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
    if (ciRequirements.length > 0) {
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
  return [
    ...secretsFile.problems,
    ...exampleFile.problems,
    ...(secrets === null ? [] : secrets.problems),
    ...(example === null ? [] : example.problems),
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
  const contractProblems = await Promise.all(
    requirement.contracts.map((contract) =>
      collectPairProblems(consumer, contract),
    ),
  );
  return [...requirement.problems, ...contractProblems.flat()];
};

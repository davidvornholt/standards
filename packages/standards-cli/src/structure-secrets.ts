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
import { inspectSyncPolicy } from './sync-policy';
import { parseYaml } from './yaml-parse';

const CI_SECRETS = 'secrets/ci.yaml';
const CI_EXAMPLE = 'secrets/ci.example.yaml';
const BROKER_REASON =
  'the synced Standards sync workflow mints a branch token with Contents write and Workflows write plus a pull request token with Contents read and Pull requests write, and the synced Standards sync and Standards auto-merge workflows mint a merge token with Contents write, Pull requests write, and Workflows write from ci.broker_app; provision it with "bun standards creds add github --dest ci:ci.broker_app"';
const BROKER_REQUIREMENTS: ReadonlyArray<RequiredSecretLeaf> = [
  { path: ['ci', 'broker_app', 'client_id'], reason: BROKER_REASON },
  { path: ['ci', 'broker_app', 'private_key'], reason: BROKER_REASON },
];

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

export const collectCiSecretsProblems = async (
  consumer: string,
): Promise<ReadonlyArray<string>> => {
  // Standards auto-merge runs whatever the sync policy says, so every
  // repository needs the broker App. The policy is still validated here
  // because this is the structure gate's only reader of it.
  const [policyProblems, secretsFile, exampleFile] = await Promise.all([
    inspectSyncPolicy(consumer),
    parseMapping(
      consumer,
      CI_SECRETS,
      `${CI_SECRETS}: must exist as a SOPS-encrypted file; the synced Standards sync and Standards auto-merge workflows read ci.broker_app from it`,
    ),
    parseMapping(
      consumer,
      CI_EXAMPLE,
      `${CI_EXAMPLE}: must exist and mirror the key shape of ${CI_SECRETS} with plaintext placeholders`,
    ),
  ]);
  const secrets =
    secretsFile.mapping === null
      ? null
      : inspectSecretDocument(
          CI_SECRETS,
          secretsFile.mapping,
          BROKER_REQUIREMENTS,
        );
  const example =
    exampleFile.mapping === null
      ? null
      : inspectExampleDocument(CI_EXAMPLE, exampleFile.mapping);
  return [
    ...policyProblems,
    ...secretsFile.problems,
    ...exampleFile.problems,
    ...(secrets === null ? [] : secrets.problems),
    ...(example === null ? [] : example.problems),
    ...(secrets !== null && example !== null
      ? secretShapeProblems({
          secretsRel: CI_SECRETS,
          exampleRel: CI_EXAMPLE,
          secrets: secrets.leaves,
          example: example.leaves,
          required: BROKER_REQUIREMENTS,
        })
      : []),
  ];
};

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from './github-settings-parse';
import { parseYaml } from './yaml-parse';

const CI_SECRETS = 'secrets/ci.yaml';
const CI_EXAMPLE = 'secrets/ci.example.yaml';
const BROKER_REASON =
  'the synced Standards sync workflow mints its pull request token from ci.broker_app; provision it with "bun standards creds add github --dest ci:ci.broker_app"';
const REQUIRED_LEAVES: ReadonlyArray<readonly [string, string]> = [
  ['ci.ntfy_topic_url', 'the synced Notify pause workflow pushes to it'],
  ['ci.broker_app.app_id', BROKER_REASON],
  ['ci.broker_app.private_key', BROKER_REASON],
];

// SOPS encrypts leaf values but keeps the mapping keys in plaintext, so the
// business-key shape of the encrypted file is comparable without decrypting
// anything — the gate never needs an age key.
const collectLeaves = (
  value: unknown,
  prefix: string,
  into: Map<string, unknown>,
): void => {
  if (isRecord(value) && (prefix === '' || Object.keys(value).length > 0)) {
    for (const [key, child] of Object.entries(value)) {
      collectLeaves(child, prefix === '' ? key : `${prefix}.${key}`, into);
    }
    return;
  }
  into.set(prefix, value);
};

const isEncryptedValue = (value: unknown): boolean =>
  typeof value === 'string'
    ? value.startsWith('ENC[')
    : Array.isArray(value) &&
      value.length > 0 &&
      value.every(
        (item) => typeof item === 'string' && item.startsWith('ENC['),
      );

type ParsedMapping = {
  readonly mapping: Record<string, unknown> | null;
  readonly problems: ReadonlyArray<string>;
};

const parseMapping = async (
  consumer: string,
  rel: string,
  missingRequirement: string,
): Promise<ParsedMapping> => {
  const raw = await readFile(join(consumer, rel), 'utf8').catch(() => null);
  if (raw === null) {
    return { mapping: null, problems: [missingRequirement] };
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

// The diagnostics below name key paths only, never values: a value that fails
// the encryption check may be a real leaked secret, and echoing it into gate
// output would spread the leak.
const inspectSecrets = (mapping: Record<string, unknown>) => {
  const { sops, ...business } = mapping;
  const leaves = new Map<string, unknown>();
  collectLeaves(business, '', leaves);
  const problems = [
    ...(isRecord(sops)
      ? []
      : [
          `${CI_SECRETS}: missing the top-level "sops" metadata block; encrypt the file with SOPS before committing it`,
        ]),
    ...[...leaves]
      .filter(([, value]) => !isEncryptedValue(value))
      .map(
        ([path]) =>
          `${CI_SECRETS}: value at "${path}" is not SOPS-encrypted; plaintext secret values must never be committed`,
      ),
    ...REQUIRED_LEAVES.filter(([path]) => !leaves.has(path)).map(
      ([path, reason]) =>
        `${CI_SECRETS}: missing required key "${path}" — ${reason}`,
    ),
  ];
  return { leaves, problems };
};

const inspectExample = (mapping: Record<string, unknown>) => {
  const { sops, ...business } = mapping;
  const leaves = new Map<string, unknown>();
  collectLeaves(business, '', leaves);
  const problems =
    sops === undefined
      ? []
      : [
          `${CI_EXAMPLE}: must hold plaintext placeholders, not SOPS-encrypted content`,
        ];
  return { leaves, problems };
};

const shapeProblems = (
  secrets: ReadonlyMap<string, unknown>,
  example: ReadonlyMap<string, unknown>,
): ReadonlyArray<string> => {
  const required = new Set(REQUIRED_LEAVES.map(([path]) => path));
  return [
    ...[...secrets.keys()]
      .filter((path) => !example.has(path))
      .map(
        (path) =>
          `${CI_EXAMPLE}: missing key "${path}"; mirror every ${CI_SECRETS} key with a placeholder`,
      ),
    // A required key already gets its own diagnostic above, so the mirror
    // comparison only reports the example-only keys beyond that set.
    ...[...example.keys()]
      .filter((path) => !(secrets.has(path) || required.has(path)))
      .map(
        (path) =>
          `${CI_SECRETS}: missing key "${path}"; add the secret or delete the stale key from ${CI_EXAMPLE}`,
      ),
  ];
};

export const collectCiSecretsProblems = async (
  consumer: string,
): Promise<ReadonlyArray<string>> => {
  const [secretsFile, exampleFile] = await Promise.all([
    parseMapping(
      consumer,
      CI_SECRETS,
      `${CI_SECRETS}: must exist as a SOPS-encrypted file; the synced CI workflows read ci.ntfy_topic_url and ci.broker_app from it`,
    ),
    parseMapping(
      consumer,
      CI_EXAMPLE,
      `${CI_EXAMPLE}: must exist and mirror the key shape of ${CI_SECRETS} with plaintext placeholders`,
    ),
  ]);
  const secrets =
    secretsFile.mapping === null ? null : inspectSecrets(secretsFile.mapping);
  const example =
    exampleFile.mapping === null ? null : inspectExample(exampleFile.mapping);
  return [
    ...secretsFile.problems,
    ...exampleFile.problems,
    ...(secrets === null ? [] : secrets.problems),
    ...(example === null ? [] : example.problems),
    ...(secrets !== null && example !== null
      ? shapeProblems(secrets.leaves, example.leaves)
      : []),
  ];
};

import { isRecord } from './github-settings-parse';
import {
  hasCompleteSopsMetadata,
  isEncryptedLeafValue,
  isSopsEncryptedScalar,
  looksEncrypted,
} from './structure-sops-envelope';

export type SecretLeaf = {
  readonly id: string;
  readonly path: string;
  readonly segments: ReadonlyArray<string>;
  readonly value: unknown;
};

export type SecretDocumentInspection = {
  readonly leaves: ReadonlyMap<string, SecretLeaf>;
  readonly problems: ReadonlyArray<string>;
};

export type RequiredSecretLeaf = {
  readonly path: ReadonlyArray<string>;
  readonly reason: string;
};

export const secretPathId = (segments: ReadonlyArray<string>): string =>
  JSON.stringify(segments);

const collectLeaves = (
  value: unknown,
  segments: ReadonlyArray<string>,
  into: Map<string, SecretLeaf>,
): void => {
  if (
    isRecord(value) &&
    (segments.length === 0 || Object.keys(value).length > 0)
  ) {
    for (const [key, child] of Object.entries(value)) {
      collectLeaves(child, [...segments, key], into);
    }
    return;
  }
  const leaf = {
    id: secretPathId(segments),
    path: segments.join('.'),
    segments,
    value,
  };
  into.set(leaf.id, leaf);
};

const businessLeaves = (
  mapping: Record<string, unknown>,
): ReadonlyMap<string, SecretLeaf> => {
  const { sops: _sops, ...business } = mapping;
  const leaves = new Map<string, SecretLeaf>();
  collectLeaves(business, [], leaves);
  return leaves;
};

const ambiguityProblems = (
  rel: string,
  leaves: ReadonlyMap<string, SecretLeaf>,
): ReadonlyArray<string> => {
  const idsByDottedPath = new Map<string, Array<string>>();
  for (const leaf of leaves.values()) {
    const ids = idsByDottedPath.get(leaf.path) ?? [];
    ids.push(leaf.id);
    idsByDottedPath.set(leaf.path, ids);
  }
  return [...idsByDottedPath]
    .filter(([, ids]) => ids.length > 1)
    .map(
      ([path]) =>
        `${rel}: key path "${path}" is ambiguous because direct dotted keys and nested mappings collide`,
    );
};

export const inspectSecretDocument = (
  rel: string,
  mapping: Record<string, unknown>,
  required: ReadonlyArray<RequiredSecretLeaf>,
): SecretDocumentInspection => {
  const leaves = businessLeaves(mapping);
  return {
    leaves,
    problems: [
      ...(hasCompleteSopsMetadata(mapping.sops)
        ? []
        : [
            `${rel}: incomplete top-level "sops" metadata; encrypt the file with SOPS before committing it`,
          ]),
      ...ambiguityProblems(rel, leaves),
      ...[...leaves.values()]
        .filter((leaf) => !isEncryptedLeafValue(leaf.value))
        .map(
          (leaf) =>
            `${rel}: value at "${leaf.path}" is not a complete SOPS-encrypted value; plaintext secret values must never be committed`,
        ),
      ...required.flatMap((requirement) => {
        const leaf = leaves.get(secretPathId(requirement.path));
        if (leaf === undefined) {
          return [
            `${rel}: missing required key "${requirement.path.join('.')}" — ${requirement.reason}`,
          ];
        }
        return isEncryptedLeafValue(leaf.value) &&
          !isSopsEncryptedScalar(leaf.value)
          ? [
              `${rel}: required key "${requirement.path.join('.')}" must be one SOPS-encrypted scalar because its workflow resolves it as a string`,
            ]
          : [];
      }),
    ],
  };
};

export const inspectExampleDocument = (
  rel: string,
  mapping: Record<string, unknown>,
): SecretDocumentInspection => {
  const leaves = businessLeaves(mapping);
  return {
    leaves,
    problems: [
      ...(mapping.sops === undefined
        ? []
        : [`${rel}: must hold plaintext placeholders, not SOPS metadata`]),
      ...ambiguityProblems(rel, leaves),
      ...[...leaves.values()]
        .filter((leaf) => looksEncrypted(leaf.value))
        .map(
          (leaf) =>
            `${rel}: value at "${leaf.path}" looks SOPS-encrypted; replace it with a plaintext placeholder`,
        ),
    ],
  };
};

type SecretShapeContext = {
  readonly secretsRel: string;
  readonly exampleRel: string;
  readonly secrets: ReadonlyMap<string, SecretLeaf>;
  readonly example: ReadonlyMap<string, SecretLeaf>;
  readonly required: ReadonlyArray<RequiredSecretLeaf>;
};

export const secretShapeProblems = ({
  secretsRel,
  exampleRel,
  secrets,
  example,
  required,
}: SecretShapeContext): ReadonlyArray<string> => {
  const requiredIds = new Set(required.map(({ path }) => secretPathId(path)));
  return [
    ...[...secrets.values()]
      .filter((leaf) => !example.has(leaf.id))
      .map(
        (leaf) =>
          `${exampleRel}: missing key "${leaf.path}" with the same mapping shape; mirror every ${secretsRel} key with a placeholder`,
      ),
    ...[...example.values()]
      .filter((leaf) => !(secrets.has(leaf.id) || requiredIds.has(leaf.id)))
      .map(
        (leaf) =>
          `${secretsRel}: missing key "${leaf.path}" with the same mapping shape; add the secret or delete the stale key from ${exampleRel}`,
      ),
  ];
};

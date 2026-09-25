// Resolves brokered S3 pair references in the composed dev env into literal
// values by decrypting each referenced SOPS target once. Resolution runs
// after layer composition so a later layer's literal can override an earlier
// layer's reference, and a reference that lost the merge is never decrypted.

import { lookupS3Pair } from './creds-r2';
import type { BrokeredS3Reference } from './dev-env-brokered';
import { prepareBrokeredSources } from './dev-env-brokered-preflight';
import { brokeredReferenceIdentity } from './dev-env-brokered-source';
import type { ComposedDevEnvTarget } from './dev-env-compose';
import { encodePortableDotenvValue } from './dev-env-dotenv-value';
import { decryptSopsJson, type SopsJsonResult } from './sops-exec';

export type ResolvedDevEnvTarget = {
  readonly group: string;
  readonly workspace: string;
  readonly env: Readonly<Record<string, string>>;
  readonly sources: ReadonlyArray<string>;
};

export type ResolvedDevEnv = {
  readonly targets: ReadonlyArray<ResolvedDevEnvTarget>;
  readonly problems: ReadonlyArray<string>;
};

// Each variable independently selects a complete pair and then one part.
// Variable names and neighboring references do not imply a shared credential.
const lookupReference = (
  document: unknown,
  reference: BrokeredS3Reference,
): { readonly value: string | null; readonly problem: string | null } => {
  const pair = lookupS3Pair(document, reference.key);
  if (!pair.ok) {
    return {
      value: null,
      problem:
        pair.kind === 'missing-key'
          ? `has no key "${reference.key}"; mint the pair with \`bun standards creds add cloudflare --s3 --dest ${reference.brokeredS3}:${reference.key}\``
          : `key "${reference.key}" does not hold a complete brokered S3 pair; both "access_key_id" and "secret_access_key" must be strings`,
    };
  }
  return {
    value:
      reference.part === 'access_key_id'
        ? pair.accessKeyId
        : pair.secretAccessKey,
    problem: null,
  };
};

export const resolveBrokeredReferences = (
  consumer: string,
  targets: ReadonlyArray<ComposedDevEnvTarget>,
  allowedReferences: ReadonlySet<string>,
  preservedReferences: ReadonlySet<string> = new Set(),
): ResolvedDevEnv => {
  const problems: Array<string> = [];
  const documents = new Map<string, SopsJsonResult>();
  const preflight = prepareBrokeredSources(
    consumer,
    targets,
    allowedReferences,
    preservedReferences,
  );
  if (preflight.problems.length > 0) {
    return {
      problems: preflight.problems,
      targets: targets.map((target) => ({
        ...target,
        env: Object.fromEntries(
          Object.entries(target.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        ),
      })),
    };
  }
  const { sources } = preflight;
  const readDocument = (reference: BrokeredS3Reference): SopsJsonResult => {
    const source = sources.get(reference);
    if (source === undefined) {
      return { ok: false, problem: 'unresolved source target' };
    }
    const documentKey = `${source.root}/${source.rel}`;
    const cached = documents.get(documentKey);
    if (cached !== undefined) {
      return cached;
    }
    const result = decryptSopsJson(source.root, source.rel);
    documents.set(documentKey, result);
    return result;
  };
  const resolveValue = (
    label: string,
    reference: BrokeredS3Reference,
  ): { readonly value: string | null; readonly problem: string | null } => {
    const allowlistEntry = brokeredReferenceIdentity(reference);
    if (preservedReferences.has(allowlistEntry)) {
      return { value: '', problem: null };
    }
    const document = readDocument(reference);
    if (!document.ok) {
      return { value: null, problem: `${label}: ${document.problem}` };
    }
    const lookup = lookupReference(document.value, reference);
    if (lookup.value === null) {
      return { value: null, problem: `${label}: ${lookup.problem}` };
    }
    if (encodePortableDotenvValue(lookup.value) === null) {
      return {
        value: null,
        problem: `${label}: resolved value cannot be represented losslessly in portable dotenv syntax`,
      };
    }
    return { value: lookup.value, problem: null };
  };
  const resolved = targets.map((target) => {
    const env = Object.create(null) as Record<string, string>;
    for (const [key, value] of Object.entries(target.env)) {
      if (typeof value === 'string') {
        env[key] = value;
      } else {
        const label = `${target.group}.${target.workspace}.${key} reference to secrets target "${value.brokeredS3}"`;
        const outcome = resolveValue(label, value);
        if (outcome.value === null) {
          problems.push(outcome.problem ?? `${label}: unresolved reference`);
        } else {
          env[key] = outcome.value;
        }
      }
    }
    return {
      group: target.group,
      workspace: target.workspace,
      env,
      sources: target.sources,
    };
  });
  return { targets: resolved, problems };
};

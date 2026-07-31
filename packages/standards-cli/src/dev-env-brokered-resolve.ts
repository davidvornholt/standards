// Resolves brokered S3 pair references in the composed dev env into literal
// values by decrypting each referenced SOPS target once. Resolution runs
// after layer composition so a later layer's literal can override an earlier
// layer's reference, and a reference that lost the merge is never decrypted.

import { resolveTargetRelResult } from './creds-target';
import type { BrokeredS3Reference } from './dev-env-brokered';
import type { ComposedDevEnvTarget } from './dev-env-compose';
import { encodeBunDotenvValue } from './dev-env-dotenv-value';
import { isRecord } from './github-settings-parse';
import { runSops } from './sops-exec';

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

type SopsDocumentResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly problem: string };

const decryptSopsJson = (consumer: string, rel: string): SopsDocumentResult => {
  const result = runSops(['--decrypt', '--output-type', 'json', rel], consumer);
  if (result.status !== 0) {
    const detail = result.errorMessage ?? result.stderr.trim();
    return {
      ok: false,
      problem: detail
        ? `could not decrypt ${rel}: ${detail}`
        : `could not decrypt ${rel}`,
    };
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout) as unknown };
  } catch (error) {
    return {
      ok: false,
      problem: `could not parse decrypted ${rel} as JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
};

const lookupReference = (
  document: unknown,
  reference: BrokeredS3Reference,
): { readonly value: string | null; readonly problem: string | null } => {
  let node: unknown = document;
  for (const segment of reference.key.split('.')) {
    if (!isRecord(node) || node[segment] === undefined) {
      return {
        value: null,
        problem: `has no key "${reference.key}"; mint the pair with \`bun standards creds add cloudflare --s3 --dest ${reference.brokeredS3}:${reference.key}\``,
      };
    }
    node = node[segment];
  }
  if (
    !isRecord(node) ||
    typeof node.access_key_id !== 'string' ||
    typeof node.secret_access_key !== 'string'
  ) {
    return {
      value: null,
      problem: `key "${reference.key}" does not hold a complete brokered S3 pair; both "access_key_id" and "secret_access_key" must be strings`,
    };
  }
  return { value: node[reference.part] as string, problem: null };
};

export const resolveBrokeredReferences = (
  consumer: string,
  targets: ReadonlyArray<ComposedDevEnvTarget>,
  allowedReferences: ReadonlySet<string>,
  preservedReferences: ReadonlySet<string> = new Set(),
): ResolvedDevEnv => {
  const problems: Array<string> = [];
  const documents = new Map<string, SopsDocumentResult>();
  const readDocument = (targetName: string): SopsDocumentResult => {
    const cached = documents.get(targetName);
    if (cached !== undefined) {
      return cached;
    }
    const resolved = resolveTargetRelResult(consumer, targetName);
    const result = resolved.ok
      ? decryptSopsJson(consumer, resolved.rel)
      : {
          ok: false as const,
          problem:
            resolved.kind === 'ambiguous'
              ? resolved.problem
              : `secrets target "${targetName}" does not exist; create it and mint the pair with \`bun standards creds add cloudflare --s3\``,
        };
    documents.set(targetName, result);
    return result;
  };
  const resolveValue = (
    label: string,
    reference: BrokeredS3Reference,
  ): { readonly value: string | null; readonly problem: string | null } => {
    const allowlistEntry = `${reference.brokeredS3}:${reference.key}`;
    if (!allowedReferences.has(allowlistEntry)) {
      return {
        value: null,
        problem: `${label}: unauthorized brokered S3 pair; add "${allowlistEntry}" to the encrypted secrets/dev.yaml brokeredReferences allowlist`,
      };
    }
    if (preservedReferences.has(allowlistEntry)) {
      return { value: '', problem: null };
    }
    const document = readDocument(reference.brokeredS3);
    if (!document.ok) {
      return { value: null, problem: `${label}: ${document.problem}` };
    }
    const lookup = lookupReference(document.value, reference);
    if (lookup.value === null) {
      return { value: null, problem: `${label}: ${lookup.problem}` };
    }
    if (encodeBunDotenvValue(lookup.value) === null) {
      return {
        value: null,
        problem: `${label}: resolved value cannot be represented losslessly in Bun dotenv syntax`,
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

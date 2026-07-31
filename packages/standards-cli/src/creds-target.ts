import { isContainedSopsPath } from './creds-sops-structure';

const SAFE_TARGET = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/u;

export const isSafeSecretsTargetName = (target: string): boolean =>
  SAFE_TARGET.test(target);

export type TargetRelResolution =
  | { readonly ok: true; readonly rel: string }
  | {
      readonly ok: false;
      readonly kind: 'invalid' | 'missing' | 'ambiguous';
      readonly problem: string;
    };

export const resolveTargetRelResult = (
  consumer: string,
  target: string,
): TargetRelResolution => {
  if (!isSafeSecretsTargetName(target)) {
    return {
      ok: false,
      kind: 'invalid',
      problem: `secrets target "${target}" is not a safe target name`,
    };
  }
  const host = `infra/hosts/${target}/secrets.yaml`;
  const flat = `secrets/${target}.yaml`;
  const hostExists = isContainedSopsPath(consumer, host, 'file');
  const flatExists = isContainedSopsPath(consumer, flat, 'file');
  if (hostExists && flatExists) {
    return {
      ok: false,
      kind: 'ambiguous',
      problem: `secrets target "${target}" is ambiguous because both ${flat} and ${host} exist; rename one target so the name binds exactly one encrypted file`,
    };
  }
  if (hostExists) {
    return { ok: true, rel: host };
  }
  if (flatExists) {
    return { ok: true, rel: flat };
  }
  return {
    ok: false,
    kind: 'missing',
    problem: `secrets target "${target}" does not exist`,
  };
};

export const resolveTargetRel = (
  consumer: string,
  target: string,
): string | null => {
  const resolved = resolveTargetRelResult(consumer, target);
  return resolved.ok ? resolved.rel : null;
};

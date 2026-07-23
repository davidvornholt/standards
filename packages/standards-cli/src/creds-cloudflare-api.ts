// Cloudflare v4 API plumbing shared by the account-token operations in
// creds-cloudflare.ts: envelope parsing, error folding, and shared types.

import { isRecord } from './github-settings-parse';

const API_ROOT = 'https://api.cloudflare.com/client/v4';

export type CfResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: string };

export type CloudflareToken = {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly expiresOn: string | null;
  readonly issuedOn: string | null;
  readonly policies: ReadonlyArray<TokenPolicy> | null;
};

export type PermissionGroup = {
  readonly id: string;
  readonly name: string;
  readonly scopes: ReadonlyArray<string>;
};

export type TokenPolicy = {
  readonly effect: 'allow' | 'deny';
  readonly resources: Readonly<
    Record<string, string | Readonly<Record<string, string>>>
  >;
  readonly permission_groups: ReadonlyArray<{ readonly id: string }>;
};

export type ResultInfo = {
  readonly page: number;
  readonly perPage: number;
  readonly count: number;
  readonly totalCount: number;
};

export type Envelope = {
  readonly success: boolean;
  readonly errors: ReadonlyArray<{ readonly message: string }>;
  readonly result: unknown;
  readonly resultInfo: ResultInfo | null;
};

export const cfRequest = async (
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<CfResult<Envelope>> => {
  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: unknown = null;
  try {
    parsed = (await response.json()) as unknown;
  } catch {
    return {
      ok: false,
      problem: `${method} ${path}: HTTP ${response.status} with a non-JSON body`,
    };
  }
  if (!isRecord(parsed)) {
    return { ok: false, problem: `${method} ${path}: unexpected response` };
  }
  const errors = Array.isArray(parsed.errors)
    ? parsed.errors.filter(isRecord).map((error) => ({
        message:
          typeof error.message === 'string' ? error.message : 'unknown error',
      }))
    : [];
  const info = isRecord(parsed.result_info) ? parsed.result_info : {};
  const resultInfo =
    typeof info.page === 'number' &&
    Number.isInteger(info.page) &&
    info.page >= 1 &&
    typeof info.per_page === 'number' &&
    Number.isInteger(info.per_page) &&
    info.per_page >= 1 &&
    typeof info.count === 'number' &&
    Number.isInteger(info.count) &&
    info.count >= 0 &&
    typeof info.total_count === 'number' &&
    Number.isInteger(info.total_count) &&
    info.total_count >= 0
      ? {
          page: info.page,
          perPage: info.per_page,
          count: info.count,
          totalCount: info.total_count,
        }
      : null;
  const envelope: Envelope = {
    success: parsed.success === true,
    errors,
    result: parsed.result,
    resultInfo,
  };
  if (!envelope.success) {
    const detail =
      errors.length > 0
        ? errors.map((error) => error.message).join('; ')
        : `HTTP ${response.status}`;
    return { ok: false, problem: `${method} ${path}: ${detail}` };
  }
  return { ok: true, value: envelope };
};

const stringRecordOf = (
  raw: unknown,
): Readonly<Record<string, string>> | null => {
  if (!isRecord(raw)) {
    return null;
  }
  return Object.values(raw).every((value) => typeof value === 'string')
    ? (raw as Readonly<Record<string, string>>)
    : null;
};

const resourcesOf = (raw: unknown): TokenPolicy['resources'] | null => {
  if (!isRecord(raw)) {
    return null;
  }
  const resources: Record<string, string | Readonly<Record<string, string>>> =
    {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      resources[key] = value;
    } else {
      const nested = stringRecordOf(value);
      if (nested === null) {
        return null;
      }
      resources[key] = nested;
    }
  }
  return resources;
};

const policyOf = (raw: unknown): TokenPolicy | null => {
  if (
    !(
      isRecord(raw) &&
      (raw.effect === 'allow' || raw.effect === 'deny') &&
      Array.isArray(raw.permission_groups)
    )
  ) {
    return null;
  }
  const resources = resourcesOf(raw.resources);
  const permissionGroups = raw.permission_groups
    .filter(isRecord)
    .filter((group) => typeof group.id === 'string')
    .map((group) => ({ id: group.id as string }));
  return resources !== null &&
    permissionGroups.length === raw.permission_groups.length
    ? {
        effect: raw.effect,
        resources,
        permission_groups: permissionGroups,
      }
    : null;
};

const policiesOf = (raw: unknown): ReadonlyArray<TokenPolicy> | null => {
  if (!Array.isArray(raw)) {
    return null;
  }
  const policies = raw.map(policyOf);
  return policies.every((policy) => policy !== null)
    ? (policies as ReadonlyArray<TokenPolicy>)
    : null;
};

export const tokenOf = (raw: unknown): CloudflareToken | null =>
  isRecord(raw) && typeof raw.id === 'string' && typeof raw.name === 'string'
    ? {
        id: raw.id,
        name: raw.name,
        status: typeof raw.status === 'string' ? raw.status : 'unknown',
        expiresOn: typeof raw.expires_on === 'string' ? raw.expires_on : null,
        issuedOn: typeof raw.issued_on === 'string' ? raw.issued_on : null,
        policies: policiesOf(raw.policies),
      }
    : null;

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
  readonly policies: unknown;
};

export type PermissionGroup = { readonly id: string; readonly name: string };

export type TokenPolicy = {
  readonly effect: 'allow';
  readonly resources: Readonly<Record<string, string>>;
  readonly permission_groups: ReadonlyArray<{ readonly id: string }>;
};

export type Envelope = {
  readonly success: boolean;
  readonly errors: ReadonlyArray<{ readonly message: string }>;
  readonly result: unknown;
  readonly totalPages: number;
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
  const envelope: Envelope = {
    success: parsed.success === true,
    errors,
    result: parsed.result,
    totalPages: typeof info.total_pages === 'number' ? info.total_pages : 1,
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

export const tokenOf = (raw: unknown): CloudflareToken | null =>
  isRecord(raw) && typeof raw.id === 'string' && typeof raw.name === 'string'
    ? {
        id: raw.id,
        name: raw.name,
        status: typeof raw.status === 'string' ? raw.status : 'unknown',
        expiresOn: typeof raw.expires_on === 'string' ? raw.expires_on : null,
        policies: raw.policies,
      }
    : null;

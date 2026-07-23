// Cloudflare account-owned API token operations for `standards creds`: the
// broker bootstrap token (permission "Account API Tokens Write") verifies
// itself, lists and mints scoped tokens, rolls their values, and revokes
// them. Token values returned by create/roll flow only into SOPS writers,
// never stdout.

import {
  type CfResult,
  type CloudflareToken,
  cfRequest,
  type PermissionGroup,
  type TokenPolicy,
  tokenOf,
} from './creds-cloudflare-api';
import { isRecord } from './github-settings-parse';

const PAGE_SIZE = 50;

export const verifyAccountToken = async (
  accountId: string,
  token: string,
): Promise<CfResult<string>> => {
  const response = await cfRequest(
    token,
    'GET',
    `/accounts/${accountId}/tokens/verify`,
  );
  if (!response.ok) {
    return response;
  }
  const status =
    isRecord(response.value.result) &&
    typeof response.value.result.status === 'string'
      ? response.value.result.status
      : 'unknown';
  return { ok: true, value: status };
};

export const listAccountTokens = async (
  accountId: string,
  token: string,
): Promise<CfResult<ReadonlyArray<CloudflareToken>>> => {
  const tokens: Array<CloudflareToken> = [];
  for (let page = 1; ; page += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: pages are sequential by definition; the next request depends on the previous page count.
    const response = await cfRequest(
      token,
      'GET',
      `/accounts/${accountId}/tokens?page=${page}&per_page=${PAGE_SIZE}`,
    );
    if (!response.ok) {
      return response;
    }
    const { result, totalPages } = response.value;
    if (Array.isArray(result)) {
      tokens.push(
        ...result
          .map(tokenOf)
          .filter((entry): entry is CloudflareToken => entry !== null),
      );
    }
    if (page >= totalPages) {
      return { ok: true, value: tokens };
    }
  }
};

export const listPermissionGroups = async (
  accountId: string,
  token: string,
): Promise<CfResult<ReadonlyArray<PermissionGroup>>> => {
  const response = await cfRequest(
    token,
    'GET',
    `/accounts/${accountId}/tokens/permission_groups?per_page=1000`,
  );
  if (!response.ok) {
    return response;
  }
  const groups = Array.isArray(response.value.result)
    ? response.value.result
        .filter(isRecord)
        .filter(
          (group): group is Record<string, unknown> & PermissionGroup =>
            typeof group.id === 'string' && typeof group.name === 'string',
        )
        .map((group) => ({ id: group.id, name: group.name }))
    : [];
  return { ok: true, value: groups };
};

export type CreatedToken = { readonly id: string; readonly value: string };

export const createAccountToken = async (
  accountId: string,
  token: string,
  request: {
    readonly name: string;
    readonly policies: ReadonlyArray<TokenPolicy>;
    readonly expiresOn: string | null;
  },
): Promise<CfResult<CreatedToken>> => {
  const response = await cfRequest(
    token,
    'POST',
    `/accounts/${accountId}/tokens`,
    {
      name: request.name,
      policies: request.policies,
      ...(request.expiresOn === null ? {} : { expires_on: request.expiresOn }),
    },
  );
  if (!response.ok) {
    return response;
  }
  const { result } = response.value;
  if (
    !(
      isRecord(result) &&
      typeof result.id === 'string' &&
      typeof result.value === 'string'
    )
  ) {
    return { ok: false, problem: 'token creation returned no id and value' };
  }
  return { ok: true, value: { id: result.id, value: result.value } };
};

export const rollAccountToken = async (
  accountId: string,
  token: string,
  tokenId: string,
): Promise<CfResult<string>> => {
  const response = await cfRequest(
    token,
    'PUT',
    `/accounts/${accountId}/tokens/${tokenId}/value`,
    {},
  );
  if (!response.ok) {
    return response;
  }
  const value = isRecord(response.value.result)
    ? response.value.result.value
    : response.value.result;
  if (typeof value !== 'string') {
    return { ok: false, problem: 'token roll returned no new value' };
  }
  return { ok: true, value };
};

export const deleteAccountToken = async (
  accountId: string,
  token: string,
  tokenId: string,
): Promise<CfResult<null>> => {
  const response = await cfRequest(
    token,
    'DELETE',
    `/accounts/${accountId}/tokens/${tokenId}`,
  );
  return response.ok ? { ok: true, value: null } : response;
};

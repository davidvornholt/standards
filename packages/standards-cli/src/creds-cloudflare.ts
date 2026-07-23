// Cloudflare account-owned API token operations for `standards creds`: the
// broker bootstrap token (permission "Account API Tokens Write") verifies
// itself, lists and mints scoped tokens, and revokes them. Token values
// returned by create flow only into SOPS writers,
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
      `/accounts/${accountId}/tokens?include_expired=true&page=${page}&per_page=${PAGE_SIZE}`,
    );
    if (!response.ok) {
      return response;
    }
    const { result, resultInfo } = response.value;
    if (!Array.isArray(result)) {
      return { ok: false, problem: 'token list returned a non-array result' };
    }
    const pageTokens = result
      .map(tokenOf)
      .filter((entry): entry is CloudflareToken => entry !== null);
    if (pageTokens.length !== result.length) {
      return { ok: false, problem: 'token list returned a malformed token' };
    }
    tokens.push(...pageTokens);
    if (resultInfo === null) {
      return {
        ok: false,
        problem:
          'token list returned invalid pagination metadata (expected page, per_page, count, and total_count)',
      };
    }
    if (resultInfo.page !== page || resultInfo.count !== result.length) {
      return {
        ok: false,
        problem: `token list returned inconsistent pagination metadata for page ${page}`,
      };
    }
    if (
      tokens.length >= resultInfo.totalCount ||
      result.length < resultInfo.perPage ||
      result.length === 0
    ) {
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
            typeof group.id === 'string' &&
            typeof group.name === 'string' &&
            Array.isArray(group.scopes) &&
            group.scopes.every((scope) => typeof scope === 'string'),
        )
        .map((group) => ({
          id: group.id,
          name: group.name,
          scopes: group.scopes,
        }))
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

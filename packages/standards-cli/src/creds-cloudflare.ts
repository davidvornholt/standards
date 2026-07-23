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
} from './creds-cloudflare-api';
import {
  encodeTokenCondition,
  type TokenCondition,
} from './creds-cloudflare-condition';
import {
  cloudflarePaginationProblem,
  decodeCloudflareTokenPage,
} from './creds-cloudflare-pagination';
import { isRecord } from './github-settings-parse';

const PAGE_SIZE = 50;

export type VerifiedToken = {
  readonly id: string | null;
  readonly status: string;
};

export const verifyAccountToken = async (
  accountId: string,
  token: string,
): Promise<CfResult<VerifiedToken>> => {
  const response = await cfRequest(
    token,
    'GET',
    `/accounts/${accountId}/tokens/verify`,
  );
  if (!response.ok) {
    return response;
  }
  const result = isRecord(response.value.result) ? response.value.result : {};
  return {
    ok: true,
    value: {
      id: typeof result.id === 'string' ? result.id : null,
      status: typeof result.status === 'string' ? result.status : 'unknown',
    },
  };
};

export const listAccountTokens = async (
  accountId: string,
  token: string,
): Promise<CfResult<ReadonlyArray<CloudflareToken>>> => {
  const tokens: Array<CloudflareToken> = [];
  const tokenIds = new Set<string>();
  let expectedTotal: number | null = null;
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
    const decoded = decodeCloudflareTokenPage(result);
    if (!decoded.ok) {
      return decoded;
    }
    const pageTokens = decoded.value;
    if (resultInfo === null) {
      return {
        ok: false,
        problem:
          'token list returned invalid pagination metadata (expected page, per_page, count, and total_count)',
      };
    }
    expectedTotal ??= resultInfo.totalCount;
    const problem = cloudflarePaginationProblem({
      page,
      resultLength: pageTokens.length,
      resultInfo,
      accumulated: tokens.length,
      expectedTotal,
      duplicate:
        new Set(pageTokens.map((entry) => entry.id)).size !==
          pageTokens.length ||
        pageTokens.some((entry) => tokenIds.has(entry.id)),
    });
    if (problem !== null) {
      return { ok: false, problem };
    }
    for (const pageToken of pageTokens) {
      tokenIds.add(pageToken.id);
    }
    tokens.push(...pageTokens);
    if (tokens.length === expectedTotal) {
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
    readonly condition: TokenCondition | null;
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
      ...(request.condition === null
        ? {}
        : { condition: encodeTokenCondition(request.condition) }),
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

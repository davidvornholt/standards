import { apiError, HTTP_NOT_FOUND, HTTP_OK, request } from './github-api';
import {
  decodeBranchSummary,
  decodeDefaultBranch,
  decodeDefaultBranchProtection,
} from './github-default-branch-response';

const HTTP_FORBIDDEN = 403;
const HTTP_UNAUTHORIZED = 401;

export type LiveDefaultBranch = {
  readonly branch: string | null;
  readonly classicProtection: boolean;
  readonly problem: string | null;
  readonly protection: Readonly<Record<string, unknown>> | null;
  readonly unverifiable: boolean;
};

export const defaultBranchPath = (repo: string, branch: string) =>
  `/repos/${repo}/branches/${encodeURIComponent(branch)}`;

export const fetchDefaultBranchProtection = async (
  token: string | null,
  repo: string,
  repositoryBody: unknown,
  detailRequired: boolean,
): Promise<LiveDefaultBranch> => {
  const decodedBranch = decodeDefaultBranch(repositoryBody);
  if (decodedBranch.value === null) {
    return {
      branch: null,
      classicProtection: false,
      problem: decodedBranch.problem,
      protection: null,
      unverifiable: false,
    };
  }
  const branch = decodedBranch.value;
  const summary = await request(token, 'GET', defaultBranchPath(repo, branch));
  if (summary.status !== HTTP_OK) {
    return {
      branch,
      classicProtection: false,
      problem: apiError(`reading default branch "${branch}"`, summary),
      protection: null,
      unverifiable: false,
    };
  }
  const decodedSummary = decodeBranchSummary(summary.body, branch);
  if (decodedSummary.value === null) {
    return {
      branch,
      classicProtection: false,
      problem: decodedSummary.problem,
      protection: null,
      unverifiable: false,
    };
  }
  const classicProtection = decodedSummary.value;
  if (!(classicProtection || detailRequired)) {
    return {
      branch,
      classicProtection,
      problem: null,
      protection: null,
      unverifiable: false,
    };
  }
  const detail = await request(
    token,
    'GET',
    `${defaultBranchPath(repo, branch)}/protection`,
  );
  if (detail.status === HTTP_NOT_FOUND && !classicProtection) {
    return {
      branch,
      classicProtection,
      problem: null,
      protection: null,
      unverifiable: false,
    };
  }
  const detailVisibilityDenied =
    detail.status === HTTP_UNAUTHORIZED ||
    detail.status === HTTP_FORBIDDEN ||
    detail.status === HTTP_NOT_FOUND;
  if (detailVisibilityDenied && !detailRequired && classicProtection) {
    return {
      branch,
      classicProtection,
      problem: null,
      protection: null,
      unverifiable: true,
    };
  }
  if (detail.status !== HTTP_OK) {
    return {
      branch,
      classicProtection,
      problem: apiError(
        `reading protection for default branch "${branch}"`,
        detail,
      ),
      protection: null,
      unverifiable: false,
    };
  }
  const decoded = decodeDefaultBranchProtection(detail.body);
  return decoded.value === null
    ? {
        branch,
        classicProtection,
        problem: decoded.problem,
        protection: null,
        unverifiable: false,
      }
    : {
        branch,
        classicProtection,
        problem: null,
        protection: decoded.value,
        unverifiable: false,
      };
};

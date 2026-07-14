import { apiError, HTTP_NO_CONTENT, HTTP_OK, request } from './github-api';
import {
  defaultBranchPath,
  fetchDefaultBranchProtection,
  type LiveDefaultBranch,
} from './github-default-branch';
import { decodeDefaultBranch } from './github-default-branch-response';
import { subsetMatches } from './github-diff';
import { isRecord } from './github-settings';

const REQUIRED_REVIEWS = 'required_pull_request_reviews';
const BYPASS_ALLOWANCES = 'bypass_pull_request_allowances';
const REQUIRED_CHECKS = 'required_status_checks';

type ApplyDefaultBranchInput = {
  readonly declared: Readonly<Record<string, unknown>>;
  readonly live: LiveDefaultBranch;
  readonly reportAction: (action: string) => void;
  readonly repo: string;
  readonly token: string;
};

const updateBody = (declared: Readonly<Record<string, unknown>>) => {
  const status = isRecord(declared[REQUIRED_CHECKS])
    ? declared[REQUIRED_CHECKS]
    : {};
  const reviews = isRecord(declared[REQUIRED_REVIEWS])
    ? declared[REQUIRED_REVIEWS]
    : {};
  return {
    ...Object.fromEntries(
      Object.entries(declared).filter(([key]) => key !== 'required_signatures'),
    ),
    [REQUIRED_REVIEWS]: Object.fromEntries(
      Object.entries(reviews).filter(([key]) => key !== BYPASS_ALLOWANCES),
    ),
    [REQUIRED_CHECKS]: status,
  };
};

const verifyUpdate = async (
  input: ApplyDefaultBranchInput,
  branch: string,
): Promise<void> => {
  const repository = await request(input.token, 'GET', `/repos/${input.repo}`);
  if (repository.status !== HTTP_OK) {
    throw new Error(
      apiError(
        'verifying repository default branch after protection update',
        repository,
      ),
    );
  }
  const currentDefault = decodeDefaultBranch(repository.body);
  if (currentDefault.value === null) {
    throw new Error(
      currentDefault.problem ??
        'GitHub returned an invalid repository default branch after protection update',
    );
  }
  if (currentDefault.value !== branch) {
    throw new Error(
      `Repository default branch changed from "${branch}" to "${currentDefault.value}" during protection update`,
    );
  }
  const verified = await fetchDefaultBranchProtection(
    input.token,
    input.repo,
    repository.body,
    true,
  );
  if (
    verified.problem !== null ||
    !verified.classicProtection ||
    verified.protection === null ||
    !subsetMatches(input.declared, verified.protection)
  ) {
    throw new Error(
      verified.problem ??
        `default branch "${branch}" did not match declared protection after update`,
    );
  }
};

export const applyDefaultBranchProtection = async (
  input: ApplyDefaultBranchInput,
): Promise<void> => {
  const { declared, live, reportAction, repo, token } = input;
  if (live.branch === null || live.problem !== null || live.unverifiable) {
    throw new Error(
      live.problem ??
        'default-branch protection is not verifiable with this token',
    );
  }
  const signatureDrift = live.protection?.required_signatures === true;
  const protectionDrift =
    live.protection === null || !subsetMatches(declared, live.protection);
  const path = `${defaultBranchPath(repo, live.branch)}/protection`;
  if (protectionDrift) {
    const updated = await request(token, 'PUT', path, updateBody(declared));
    if (updated.status !== HTTP_OK) {
      throw new Error(
        apiError(
          `updating protection for default branch "${live.branch}"`,
          updated,
        ),
      );
    }
    reportAction(
      `updated classic protection for default branch "${live.branch}"`,
    );
  }
  if (signatureDrift && declared.required_signatures === false) {
    const removed = await request(
      token,
      'DELETE',
      `${path}/required_signatures`,
    );
    if (removed.status !== HTTP_NO_CONTENT) {
      throw new Error(
        apiError(
          `removing required signatures from default branch "${live.branch}"`,
          removed,
        ),
      );
    }
    reportAction(
      `removed required signatures from default branch "${live.branch}"`,
    );
  }
  if (protectionDrift || signatureDrift) {
    await verifyUpdate(input, live.branch);
  }
};

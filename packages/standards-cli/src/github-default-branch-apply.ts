import {
  apiError,
  type BeforeGithubMutation,
  HTTP_NO_CONTENT,
  HTTP_OK,
  mutate,
  noGithubMutationGuard,
  request,
} from './github-api';
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
  readonly beforeMutation?: BeforeGithubMutation;
  readonly declared: Readonly<Record<string, unknown>>;
  readonly live: LiveDefaultBranch;
  readonly reportAction: (action: string) => void;
  readonly repo: string;
  readonly token: string;
};

type FreshDefaultBranchInput = Pick<
  ApplyDefaultBranchInput,
  'declared' | 'repo' | 'token'
> & {
  readonly context: string;
  readonly expectedBranch: string | null;
};

const readRepositoryDefaultBranch = async (
  input: Pick<FreshDefaultBranchInput, 'repo' | 'token'>,
): Promise<{ readonly body: unknown; readonly value: string }> => {
  const repository = await request(input.token, 'GET', `/repos/${input.repo}`);
  if (repository.status !== HTTP_OK) {
    throw new Error(
      apiError('verifying repository default branch protection', repository),
    );
  }
  const decoded = decodeDefaultBranch(repository.body);
  if (decoded.value === null) {
    throw new Error(
      decoded.problem ??
        'GitHub returned an invalid repository default branch during protection verification',
    );
  }
  return { body: repository.body, value: decoded.value };
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

export const assertFreshDefaultBranchProtection = async (
  input: FreshDefaultBranchInput,
): Promise<string> => {
  const currentDefault = await readRepositoryDefaultBranch(input);
  if (
    input.expectedBranch !== null &&
    currentDefault.value !== input.expectedBranch
  ) {
    throw new Error(
      `Repository default branch changed from "${input.expectedBranch}" to "${currentDefault.value}" during protection update`,
    );
  }
  const verified = await fetchDefaultBranchProtection(
    input.token,
    input.repo,
    currentDefault.body,
    true,
  );
  const trailingDefault = await readRepositoryDefaultBranch(input);
  if (trailingDefault.value !== currentDefault.value) {
    throw new Error(
      `Repository default branch changed from "${currentDefault.value}" to "${trailingDefault.value}" during protection verification`,
    );
  }
  if (
    verified.problem !== null ||
    !verified.classicProtection ||
    verified.protection === null ||
    !subsetMatches(input.declared, verified.protection)
  ) {
    throw new Error(
      verified.problem ??
        `default branch "${currentDefault.value}" did not match declared protection ${input.context}`,
    );
  }
  return currentDefault.value;
};

const verifyUpdate = async (
  input: ApplyDefaultBranchInput,
  branch: string,
): Promise<void> => {
  await assertFreshDefaultBranchProtection({
    ...input,
    context: 'after update',
    expectedBranch: branch,
  });
};

export const applyDefaultBranchProtection = async (
  input: ApplyDefaultBranchInput,
): Promise<void> => {
  const { declared, live, reportAction, repo, token } = input;
  const beforeMutation = input.beforeMutation ?? noGithubMutationGuard;
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
  const beforeProtectionMutation: BeforeGithubMutation = async () => {
    await beforeMutation();
    const current = await readRepositoryDefaultBranch(input);
    if (current.value !== live.branch) {
      throw new Error(
        `Repository default branch changed from "${live.branch}" to "${current.value}" before protection mutation`,
      );
    }
  };
  if (protectionDrift) {
    const updated = await mutate({
      beforeMutation: beforeProtectionMutation,
      body: updateBody(declared),
      method: 'PUT',
      path,
      token,
    });
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
    const removed = await mutate({
      beforeMutation: beforeProtectionMutation,
      method: 'DELETE',
      path: `${path}/required_signatures`,
      token,
    });
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

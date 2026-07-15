import {
  apiError,
  type BeforeGithubMutation,
  HTTP_NO_CONTENT,
  HTTP_OK,
  mutate,
  noGithubMutationGuard,
  request,
} from './github-api';
import { assertFreshDefaultBranchProtection } from './github-default-branch-apply';
import { decodeRepositoryRulesetDetail } from './github-ruleset-response';

type DeleteRulesetInput = {
  readonly beforeMutation?: BeforeGithubMutation;
  readonly declaredNames: ReadonlySet<string>;
  readonly defaultBranchProtection: Readonly<Record<string, unknown>>;
  readonly liveRuleset: Readonly<Record<string, unknown>>;
  readonly name: string;
  readonly repo: string;
  readonly token: string;
};

export const deleteVerifiedUndeclaredRuleset = async (
  input: DeleteRulesetInput,
): Promise<string> => {
  const beforeDeletion: BeforeGithubMutation = async () => {
    await (input.beforeMutation ?? noGithubMutationGuard)();
    await assertFreshDefaultBranchProtection({
      context: 'before ruleset deletion',
      declared: input.defaultBranchProtection,
      expectedBranch: null,
      repo: input.repo,
      token: input.token,
    });
    const fresh = await request(
      input.token,
      'GET',
      `/repos/${input.repo}/rulesets/${input.liveRuleset.id}`,
    );
    if (fresh.status !== HTTP_OK) {
      throw new Error(
        apiError(`re-reading ruleset "${input.name}" before deletion`, fresh),
      );
    }
    const decoded = decodeRepositoryRulesetDetail(fresh.body, input.repo, true);
    if (decoded.value === null) {
      throw new Error(
        `re-reading ruleset "${input.name}" before deletion: ${decoded.problem ?? 'GitHub returned an invalid detailed repository ruleset state'}`,
      );
    }
    const freshName = String(decoded.value.name);
    if (
      decoded.value.id !== input.liveRuleset.id ||
      freshName !== input.name ||
      input.declaredNames.has(freshName)
    ) {
      throw new Error(
        `ruleset "${input.name}" changed identity or declaration status before deletion; refusing to delete ruleset ${String(input.liveRuleset.id)}`,
      );
    }
  };

  // GitHub's ruleset DELETE endpoint exposes no conditional validator. Keep
  // the exact identity read as the guard's final request so the destructive
  // request immediately follows the freshest available remote identity proof.
  const deleted = await mutate({
    beforeMutation: beforeDeletion,
    method: 'DELETE',
    path: `/repos/${input.repo}/rulesets/${input.liveRuleset.id}`,
    token: input.token,
  });
  if (deleted.status !== HTTP_NO_CONTENT) {
    throw new Error(apiError(`deleting ruleset "${input.name}"`, deleted));
  }
  return `deleted undeclared ruleset "${input.name}"`;
};

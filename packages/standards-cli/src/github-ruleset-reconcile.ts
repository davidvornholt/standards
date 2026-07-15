import {
  apiError,
  type BeforeGithubMutation,
  HTTP_CREATED,
  HTTP_OK,
  mutate,
} from './github-api';
import { diffRuleset } from './github-diff';

type ReconcileRulesetInput = {
  readonly beforeMutation: BeforeGithubMutation;
  readonly liveRuleset: Readonly<Record<string, unknown>> | undefined;
  readonly repo: string;
  readonly ruleset: Readonly<Record<string, unknown>>;
  readonly token: string;
};

export const reconcileRuleset = async ({
  beforeMutation,
  liveRuleset,
  repo,
  ruleset,
  token,
}: ReconcileRulesetInput): Promise<string | null> => {
  const name = String(ruleset.name);
  if (liveRuleset === undefined) {
    const created = await mutate({
      beforeMutation,
      body: ruleset,
      method: 'POST',
      path: `/repos/${repo}/rulesets`,
      token,
    });
    if (created.status !== HTTP_CREATED) {
      throw new Error(apiError(`creating ruleset "${name}"`, created));
    }
    return `created ruleset "${name}"`;
  }
  const diff = diffRuleset(ruleset, liveRuleset);
  if (diff.drifted.length === 0 && diff.unverifiable.length === 0) {
    return null;
  }
  const updated = await mutate({
    beforeMutation,
    body: ruleset,
    method: 'PUT',
    path: `/repos/${repo}/rulesets/${liveRuleset.id}`,
    token,
  });
  if (updated.status !== HTTP_OK) {
    throw new Error(apiError(`updating ruleset "${name}"`, updated));
  }
  return `updated ruleset "${name}"`;
};

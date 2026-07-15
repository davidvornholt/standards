import {
  apiError,
  type BeforeGithubMutation,
  HTTP_NO_CONTENT,
  mutate,
} from './github-api';
import type { LiveEnvironment } from './github-environments';
import { isRecord } from './github-settings-value';

const CUSTOM_DEPLOYMENT_PROTECTION_RULES = 'custom_deployment_protection_rules';

type DeleteCustomProtectionRulesInput = {
  readonly beforeMutation: BeforeGithubMutation;
  readonly name: string;
  readonly path: string;
  readonly reportAction: (action: string) => void;
  readonly rules: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly token: string;
};

export const customProtectionRulesFrom = (
  live: LiveEnvironment,
): ReadonlyArray<Readonly<Record<string, unknown>>> =>
  Array.isArray(live.environment?.[CUSTOM_DEPLOYMENT_PROTECTION_RULES])
    ? live.environment[CUSTOM_DEPLOYMENT_PROTECTION_RULES].filter(isRecord)
    : [];

export const deleteCustomProtectionRules = async (
  input: DeleteCustomProtectionRulesInput,
): Promise<ReadonlyArray<string>> => {
  const actions: Array<string> = [];
  for (const rule of input.rules) {
    // biome-ignore lint/performance/noAwaitInLoops: GitHub write requests are intentionally serialized to avoid secondary rate limits.
    const deleted = await mutate({
      beforeMutation: input.beforeMutation,
      method: 'DELETE',
      path: `${input.path}/deployment_protection_rules/${rule.id}`,
      token: input.token,
    });
    const app = isRecord(rule.app) ? rule.app : {};
    if (deleted.status !== HTTP_NO_CONTENT) {
      throw new Error(
        apiError(
          `deleting custom deployment protection rule "${String(app.slug)}" from "${input.name}"`,
          deleted,
        ),
      );
    }
    const action = `deleted undeclared custom deployment protection rule "${String(app.slug)}" from environment "${input.name}"`;
    actions.push(action);
    input.reportAction(action);
  }
  return actions;
};

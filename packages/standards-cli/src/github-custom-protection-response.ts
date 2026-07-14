import { isPositiveSafeInteger } from './github-environment-settings';
import { isRecord } from './github-settings';

type DecodeResult<T> = {
  readonly problem: string | null;
  readonly value: T | null;
};

export type DecodedCustomProtectionRules = {
  readonly rules: ReadonlyArray<Readonly<Record<string, unknown>>>;
};

const invalid = (
  context: string,
  detail: string,
): DecodeResult<DecodedCustomProtectionRules> => ({
  problem: `${context}: GitHub returned ${detail}`,
  value: null,
});

export const decodeCustomProtectionRules = (
  body: unknown,
  name: string,
): DecodeResult<DecodedCustomProtectionRules> => {
  const context = `listing custom deployment protection rules for environment "${name}"`;
  if (
    !(isRecord(body) && Number.isSafeInteger(body.total_count)) ||
    Number(body.total_count) < 0 ||
    !Array.isArray(body.custom_deployment_protection_rules) ||
    body.custom_deployment_protection_rules.length !== Number(body.total_count)
  ) {
    return invalid(context, 'an invalid custom-protection-rule collection');
  }
  const rules: Array<Readonly<Record<string, unknown>>> = [];
  const ruleIds = new Set<number>();
  const appIds = new Set<number>();
  for (const rule of body.custom_deployment_protection_rules) {
    const app = isRecord(rule) ? rule.app : null;
    if (
      !(isRecord(rule) && isPositiveSafeInteger(rule.id)) ||
      rule.enabled !== true ||
      !isRecord(app) ||
      !isPositiveSafeInteger(app.id) ||
      typeof app.slug !== 'string' ||
      app.slug.length === 0 ||
      ruleIds.has(rule.id) ||
      appIds.has(app.id)
    ) {
      return invalid(context, 'an invalid custom protection rule identity');
    }
    ruleIds.add(rule.id);
    appIds.add(app.id);
    rules.push({ app: { id: app.id, slug: app.slug }, id: rule.id });
  }
  return { problem: null, value: { rules } };
};

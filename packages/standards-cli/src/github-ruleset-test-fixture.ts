export const declaredRuleset = (
  name: string,
): Readonly<Record<string, unknown>> =>
  JSON.parse(
    `{"bypass_actors":[],"conditions":{"ref_name":{"exclude":[],"include":["~DEFAULT_BRANCH"]}},"enforcement":"active","name":${JSON.stringify(name)},"rules":[{"type":"deletion"}],"target":"branch"}`,
  ) as Readonly<Record<string, unknown>>;

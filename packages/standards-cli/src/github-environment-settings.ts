// Structural validation for declarative GitHub Actions environments.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const ENVIRONMENT_KEYS = new Set([
  'name',
  'wait_timer',
  'prevent_self_review',
  'reviewers',
  'deployment_branch_policy',
  'deployment_branch_policies',
]);
const REVIEWER_KEYS = new Set(['type', 'id']);
const BRANCH_POLICY_MODE_KEYS = new Set([
  'protected_branches',
  'custom_branch_policies',
]);
const DEPLOYMENT_POLICY_KEYS = new Set(['name', 'type']);

const unknownKeyProblems = (
  record: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  prefix: string,
): ReadonlyArray<string> =>
  Object.keys(record).flatMap((key) =>
    allowed.has(key) ? [] : [`${prefix} has unknown key "${key}"`],
  );

const reviewerProblems = (
  reviewers: unknown,
  prefix: string,
): ReadonlyArray<string> => {
  if (!Array.isArray(reviewers)) {
    return [`${prefix}.reviewers must be an array`];
  }
  return reviewers.flatMap((reviewer, index) => {
    const reviewerPrefix = `${prefix}.reviewers[${index}]`;
    if (!isRecord(reviewer)) {
      return [
        `${reviewerPrefix} must have type "User" or "Team" and an integer id`,
      ];
    }
    return [
      ...unknownKeyProblems(reviewer, REVIEWER_KEYS, reviewerPrefix),
      ...((reviewer.type === 'User' || reviewer.type === 'Team') &&
      Number.isInteger(reviewer.id)
        ? []
        : [
            `${reviewerPrefix} must have type "User" or "Team" and an integer id`,
          ]),
    ];
  });
};

const branchPolicyModeProblems = (
  policy: unknown,
  prefix: string,
): ReadonlyArray<string> => {
  const policyPrefix = `${prefix}.deployment_branch_policy`;
  if (!isRecord(policy)) {
    return [`${policyPrefix} must enable exactly one branch-policy mode`];
  }
  return [
    ...unknownKeyProblems(policy, BRANCH_POLICY_MODE_KEYS, policyPrefix),
    ...(typeof policy.protected_branches === 'boolean' &&
    typeof policy.custom_branch_policies === 'boolean' &&
    policy.protected_branches !== policy.custom_branch_policies
      ? []
      : [`${policyPrefix} must enable exactly one branch-policy mode`]),
  ];
};

const deploymentPolicyProblems = (
  policies: unknown,
  prefix: string,
): ReadonlyArray<string> => {
  if (!Array.isArray(policies)) {
    return [`${prefix}.deployment_branch_policies must be an array`];
  }
  const names = new Set<string>();
  return policies.flatMap((policy, index) => {
    const policyPrefix = `${prefix}.deployment_branch_policies[${index}]`;
    if (
      !(
        isRecord(policy) &&
        typeof policy.name === 'string' &&
        policy.name.length > 0 &&
        (policy.type === 'branch' || policy.type === 'tag')
      )
    ) {
      return [
        `${policyPrefix} must have a non-empty name and type "branch" or "tag"`,
      ];
    }
    const key = `${policy.type}:${policy.name}`;
    if (names.has(key)) {
      return [
        `${prefix} declares deployment policy "${policy.name}" more than once`,
      ];
    }
    names.add(key);
    return unknownKeyProblems(policy, DEPLOYMENT_POLICY_KEYS, policyPrefix);
  });
};

const policyModeConsistencyProblems = (
  environment: Readonly<Record<string, unknown>>,
  prefix: string,
): ReadonlyArray<string> => {
  const mode = environment.deployment_branch_policy;
  const policies = environment.deployment_branch_policies;
  return isRecord(mode) &&
    mode.custom_branch_policies === false &&
    Array.isArray(policies) &&
    policies.length > 0
    ? [
        `${prefix}.deployment_branch_policies must be empty when custom branch policies are disabled`,
      ]
    : [];
};

const environmentProblems = (
  environment: Readonly<Record<string, unknown>>,
  prefix: string,
): ReadonlyArray<string> => [
  ...unknownKeyProblems(environment, ENVIRONMENT_KEYS, prefix),
  ...(Number.isInteger(environment.wait_timer) &&
  Number(environment.wait_timer) >= 0
    ? []
    : [`${prefix}.wait_timer must be a non-negative integer`]),
  ...(typeof environment.prevent_self_review === 'boolean'
    ? []
    : [`${prefix}.prevent_self_review must be a boolean`]),
  ...reviewerProblems(environment.reviewers, prefix),
  ...branchPolicyModeProblems(environment.deployment_branch_policy, prefix),
  ...deploymentPolicyProblems(environment.deployment_branch_policies, prefix),
  ...policyModeConsistencyProblems(environment, prefix),
];

export const environmentListProblems = (
  environments: ReadonlyArray<unknown>,
  label: string,
): ReadonlyArray<string> => {
  const names = new Set<string>();
  return environments.flatMap((environment, index) => {
    const prefix = `${label} environments[${index}]`;
    if (
      !(
        isRecord(environment) &&
        typeof environment.name === 'string' &&
        environment.name.length > 0
      )
    ) {
      return [`${prefix} must be an object with a non-empty "name"`];
    }
    const duplicate = names.has(environment.name);
    names.add(environment.name);
    return [
      ...(duplicate
        ? [`${label} declares environment "${environment.name}" more than once`]
        : []),
      ...environmentProblems(environment, prefix),
    ];
  });
};

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyDeliveryRun } from './automation-delivery-verify';
import {
  AUTOMATION_PROOF_FILE,
  type AutomationProof,
  type EnvironmentPlaneProof,
  isolationPolicySha256,
  readAutomationProof,
} from './automation-proof';
import {
  type ApiResponse,
  apiError,
  HTTP_OK,
  request,
  resolveGithubRepo,
} from './github-api';
import { isRecord } from './github-settings-parse';
import { sopsAgeRecipients } from './structure-sops-envelope';
import { readSyncPolicy, type SyncPolicy } from './sync-policy';
import { parseYaml } from './yaml-parse';

type GithubRequest = (
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
) => Promise<ApiResponse>;
export type DeliveryRuns = Partial<
  Readonly<Record<'automation' | 'notifications', number>>
>;
export type VerifyAutomationOptions = {
  readonly consumer: string;
  readonly token: string;
  readonly api?: GithubRequest;
  readonly now?: number;
  readonly deliveryRuns?: DeliveryRuns;
};
type VerifyPlaneOptions = {
  readonly api: GithubRequest;
  readonly token: string;
  readonly repo: string;
  readonly ownerType: 'Organization' | 'User';
  readonly name: 'automation' | 'notifications';
  readonly selected: NonNullable<
    SyncPolicy['automation'] | SyncPolicy['notifications']
  >;
};

const MILLISECONDS_PER_SECOND = 1000;
const PRIVATE_USER_PLANS = new Set(['pro']);
const PRIVATE_ORGANIZATION_PLANS = new Set(['team', 'business', 'enterprise']);

const apiObject = async (
  call: Promise<ApiResponse>,
  context: string,
): Promise<Record<string, unknown>> => {
  const response = await call;
  if (response.status !== HTTP_OK || !isRecord(response.body)) {
    throw new Error(apiError(context, response));
  }
  return response.body;
};

const namesFromList = (
  body: Record<string, unknown>,
  key: string,
  context: string,
): ReadonlyArray<Record<string, unknown>> => {
  const values = body[key];
  if (
    !Array.isArray(values) ||
    typeof body.total_count !== 'number' ||
    body.total_count !== values.length ||
    !values.every(isRecord)
  ) {
    throw new Error(`${context}: response was incomplete or malformed`);
  }
  return values;
};

const secondTimestamp = (now: number): string =>
  new Date(Math.floor(now / MILLISECONDS_PER_SECOND) * MILLISECONDS_PER_SECOND)
    .toISOString()
    .replace('.000Z', 'Z');

const readLegacyRecipients = async (
  consumer: string,
  policy: SyncPolicy,
  previous: AutomationProof | null,
): Promise<ReadonlyArray<string>> => {
  const path = join(consumer, 'secrets/ci.yaml');
  if (!existsSync(path)) {
    const previousRecipients = previous?.legacyAgeRecipients ?? [];
    if (previousRecipients.length > 0) {
      return previousRecipients;
    }
    throw new Error(
      'secrets/ci.yaml must remain until the first environment proof records its legacy recipient',
    );
  }
  const parsed = parseYaml(await readFile(path, 'utf8'), 'secrets/ci.yaml');
  if (parsed.problem !== null || !isRecord(parsed.value)) {
    throw new Error(parsed.problem ?? 'secrets/ci.yaml must be a YAML mapping');
  }
  const recovery = new Set(policy.recoveryAgeRecipients ?? []);
  const recipients = [
    ...new Set(
      sopsAgeRecipients(parsed.value.sops).filter(
        (recipient) => !recovery.has(recipient),
      ),
    ),
  ].sort();
  if (recipients.length === 0) {
    throw new Error(
      'secrets/ci.yaml must expose at least one legacy workflow age recipient before isolation',
    );
  }
  return recipients;
};

const verifyPlane = async ({
  api,
  token,
  repo,
  ownerType,
  name,
  selected,
}: VerifyPlaneOptions): Promise<EnvironmentPlaneProof> => {
  const encoded = encodeURIComponent(selected.environment);
  const environment = await apiObject(
    api(token, 'GET', `/repos/${repo}/environments/${encoded}`),
    `reading ${name} environment`,
  );
  const deployment = environment.deployment_branch_policy;
  if (
    !isRecord(deployment) ||
    deployment.protected_branches !== false ||
    deployment.custom_branch_policies !== true
  ) {
    throw new Error(
      `${name} environment must use only custom deployment branch policies`,
    );
  }
  const policiesBody = await apiObject(
    api(
      token,
      'GET',
      `/repos/${repo}/environments/${encoded}/deployment-branch-policies?per_page=100`,
    ),
    `reading ${name} deployment branches`,
  );
  const policies = namesFromList(
    policiesBody,
    'branch_policies',
    `${name} deployment branches`,
  );
  if (
    policies.length !== 1 ||
    policies[0]?.name !== 'main' ||
    policies[0]?.type !== 'branch'
  ) {
    throw new Error(
      `${name} environment must allow only the exact main branch`,
    );
  }
  const envSecretsBody = await apiObject(
    api(
      token,
      'GET',
      `/repos/${repo}/environments/${encoded}/secrets?per_page=100`,
    ),
    `reading ${name} environment secrets`,
  );
  const envSecrets = namesFromList(
    envSecretsBody,
    'secrets',
    `${name} environment secrets`,
  );
  if (!envSecrets.some((secret) => secret.name === selected.ageKeySecret)) {
    throw new Error(
      `${name} environment secret ${selected.ageKeySecret} is missing`,
    );
  }
  const repoSecretsBody = await apiObject(
    api(token, 'GET', `/repos/${repo}/actions/secrets?per_page=100`),
    'reading repository Actions secrets',
  );
  if (
    namesFromList(
      repoSecretsBody,
      'secrets',
      'repository Actions secrets',
    ).some((secret) => secret.name === selected.ageKeySecret)
  ) {
    throw new Error(
      `${selected.ageKeySecret} must be absent at repository scope`,
    );
  }
  let organizationSecret: EnvironmentPlaneProof['organizationSecret'] =
    'not-applicable';
  if (ownerType === 'Organization') {
    const [owner] = repo.split('/');
    const response = await api(
      token,
      'GET',
      `/orgs/${owner}/actions/secrets?per_page=100`,
    );
    if (response.status === HTTP_OK && isRecord(response.body)) {
      if (
        namesFromList(
          response.body,
          'secrets',
          'organization Actions secrets',
        ).some((secret) => secret.name === selected.ageKeySecret)
      ) {
        throw new Error(
          `${selected.ageKeySecret} must be absent at organization scope`,
        );
      }
      organizationSecret = 'absent';
    } else {
      throw new Error(
        `${apiError('reading organization Actions secrets', response)}; organization secret scope must be observable before isolation adoption`,
      );
    }
  }
  return {
    environmentId: Number(environment.id),
    environment: selected.environment,
    branchPolicyIds: [Number(policies[0]?.id)],
    secretName: selected.ageKeySecret,
    repositorySecretAbsent: true,
    organizationSecret,
    ageRecipient: selected.ageRecipient,
  };
};

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Splitting this transaction would obscure which checks belong to the single recorded observation.
export const verifyAutomationEnvironments = async (
  {
    consumer,
    token,
    api = request,
    now = Date.now(),
    deliveryRuns = {},
  }: VerifyAutomationOptions,
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One administrator snapshot must bind identity, capability, environment policy, secret scope, and prior delivery evidence atomically.
): Promise<AutomationProof> => {
  const repo = resolveGithubRepo(consumer);
  if (repo === null) {
    throw new Error(
      'cannot determine the GitHub repository from the origin remote',
    );
  }
  const policy = await readSyncPolicy(consumer);
  if (policy.automation === undefined && policy.notifications === undefined) {
    throw new Error(
      'sync-standards.local.json must select at least one isolated workflow plane',
    );
  }
  const repository = await apiObject(
    api(token, 'GET', `/repos/${repo}`),
    `reading repository ${repo}`,
  );
  const { owner } = repository;
  if (
    !isRecord(owner) ||
    (owner.type !== 'Organization' && owner.type !== 'User') ||
    repository.default_branch !== 'main'
  ) {
    throw new Error(
      'repository owner identity and exact main default branch must be observable',
    );
  }
  const viewer = await apiObject(
    api(token, 'GET', '/user'),
    'reading authenticated GitHub identity',
  );
  const permission = await apiObject(
    api(
      token,
      'GET',
      `/repos/${repo}/collaborators/${encodeURIComponent(String(viewer.login))}/permission`,
    ),
    'checking repository administrator permission',
  );
  if (
    !(isRecord(permission.user) && isRecord(permission.user.permissions)) ||
    permission.user.permissions.admin !== true
  ) {
    throw new Error(
      'automation verification requires repository administrator auth',
    );
  }
  let ownerPlan = 'not-required';
  let capability: AutomationProof['repository']['capability'] =
    'public-repository';
  if (repository.private === true) {
    const ownerResponse =
      owner.type === 'Organization'
        ? await apiObject(
            api(token, 'GET', `/orgs/${owner.login}`),
            'reading organization plan',
          )
        : viewer;
    if (
      owner.type === 'User' &&
      String(viewer.login).toLowerCase() !== String(owner.login).toLowerCase()
    ) {
      throw new Error(
        'private personal repositories require owner-authenticated plan verification',
      );
    }
    ownerPlan = isRecord(ownerResponse.plan)
      ? String(ownerResponse.plan.name)
      : '';
    const allowedPlans =
      owner.type === 'Organization'
        ? PRIVATE_ORGANIZATION_PLANS
        : PRIVATE_USER_PLANS;
    if (!allowedPlans.has(ownerPlan)) {
      throw new Error(
        `private ${owner.type === 'Organization' ? 'organization' : 'personal'} repositories require a recognized GitHub ${owner.type === 'Organization' ? 'Team/Enterprise' : 'Pro'} plan; observed unsupported plan "${ownerPlan || 'missing'}", so retain the legacy secret or adopt a separately reviewed OIDC/trusted-repository design`,
      );
    }
    capability = 'paid-private-owner';
  }
  const previous = await readAutomationProof(consumer).catch(() => null);
  const policySha256 = isolationPolicySha256(policy);
  const observedAt = secondTimestamp(now);
  const planes: AutomationProof['planes'] = {
    ...(policy.automation === undefined
      ? {}
      : {
          automation: await verifyPlane({
            api,
            token,
            repo,
            ownerType: owner.type,
            name: 'automation',
            selected: policy.automation,
          }),
        }),
    ...(policy.notifications === undefined
      ? {}
      : {
          notifications: await verifyPlane({
            api,
            token,
            repo,
            ownerType: owner.type,
            name: 'notifications',
            selected: policy.notifications,
          }),
        }),
  };
  const sameCapability =
    previous?.policySha256 === policySha256 &&
    previous.repository.id === repository.id &&
    previous.repository.ownerId === owner.id &&
    previous.repository.capability === capability;
  const legacyAgeRecipients = await readLegacyRecipients(
    consumer,
    policy,
    previous,
  );
  for (const name of ['automation', 'notifications'] as const) {
    const selected = policy[name];
    if (
      selected !== undefined &&
      legacyAgeRecipients.includes(selected.ageRecipient)
    ) {
      throw new Error(
        `${name} age recipient must be distinct from every legacy CI age recipient`,
      );
    }
  }
  const proof: AutomationProof = {
    version: 1,
    repository: {
      id: Number(repository.id),
      ownerId: Number(owner.id),
      fullName: String(repository.full_name),
      private: repository.private === true,
      defaultBranch: 'main',
      ownerType: owner.type,
      ownerPlan,
      capability,
    },
    policySha256,
    capabilityObservedAt: sameCapability
      ? previous.capabilityObservedAt
      : observedAt,
    observedAt,
    legacyAgeRecipients,
    planes,
  };
  const deliveries = await Promise.all(
    (['automation', 'notifications'] as const).map(async (name) => {
      const plane = proof.planes[name];
      const selected = policy[name];
      if (plane === undefined || selected === undefined) {
        return null;
      }
      const runId = deliveryRuns[name];
      const retained =
        previous?.policySha256 === policySha256
          ? previous.planes[name]?.delivery
          : undefined;
      const delivery =
        runId === undefined
          ? retained
          : await verifyDeliveryRun({
              api,
              token,
              repo,
              consumer,
              plane: name,
              runId,
              environment: selected.environment,
              capabilityObservedAt: proof.capabilityObservedAt,
            });
      return delivery === undefined ? null : { name, plane, delivery };
    }),
  );
  for (const result of deliveries) {
    if (result !== null) {
      (proof.planes as Record<string, EnvironmentPlaneProof>)[result.name] = {
        ...result.plane,
        delivery: result.delivery,
      };
    }
  }
  return proof;
};

export const writeAutomationProof = async (
  consumer: string,
  proof: AutomationProof,
): Promise<void> => {
  await writeFile(
    join(consumer, AUTOMATION_PROOF_FILE),
    `${JSON.stringify(proof, null, 2)}\n`,
    { mode: 0o644 },
  );
};

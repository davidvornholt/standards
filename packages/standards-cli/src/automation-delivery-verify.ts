import type { DeliveryProof } from './automation-proof';
import { isolationPolicySha256 } from './automation-proof';
import { type ApiResponse, apiError, HTTP_OK } from './github-api';
import { isRecord } from './github-settings-parse';
import { parseSyncPolicy, readSyncPolicy } from './sync-policy';

type GithubRequest = (
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
) => Promise<ApiResponse>;
type PlaneName = 'automation' | 'notifications';
type VerifyDeliveryOptions = {
  readonly api: GithubRequest;
  readonly token: string;
  readonly repo: string;
  readonly consumer: string;
  readonly plane: PlaneName;
  readonly runId: number;
  readonly environment: string;
  readonly capabilityObservedAt: string;
};

const COMMIT_SHA = /^[0-9a-f]{40}$/u;

const objectResponse = async (
  response: Promise<ApiResponse>,
  context: string,
): Promise<Record<string, unknown>> => {
  const value = await response;
  if (value.status !== HTTP_OK || !isRecord(value.body)) {
    throw new Error(apiError(context, value));
  }
  return value.body;
};

const arrayResponse = async (
  response: Promise<ApiResponse>,
  context: string,
): Promise<ReadonlyArray<Record<string, unknown>>> => {
  const value = await response;
  if (
    value.status !== HTTP_OK ||
    !Array.isArray(value.body) ||
    !value.body.every(isRecord)
  ) {
    throw new Error(apiError(context, value));
  }
  return value.body;
};

const expected = (plane: PlaneName) =>
  plane === 'automation'
    ? {
        path: '.github/workflows/standards-sync.yml',
        events: ['schedule'],
        job: 'sync',
        steps: ['Resolve broker App ID', 'Resolve broker App private key'],
      }
    : {
        path: '.github/workflows/notify-pause.yml',
        events: ['issues', 'pull_request_target'],
        job: 'notify',
        steps: ['Resolve notification topic URL', 'Push a notification'],
      };

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Delivery evidence is an intentionally linear source-to-deployment chain; keeping it together makes omissions auditable.
export const verifyDeliveryRun = async ({
  api,
  token,
  repo,
  consumer,
  plane,
  runId,
  environment,
  capabilityObservedAt,
}: VerifyDeliveryOptions): Promise<DeliveryProof> => {
  const shape = expected(plane);
  const run = await objectResponse(
    api(token, 'GET', `/repos/${repo}/actions/runs/${runId}`),
    `reading ${plane} delivery run`,
  );
  if (
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.head_branch !== 'main' ||
    typeof run.head_sha !== 'string' ||
    !COMMIT_SHA.test(run.head_sha) ||
    typeof run.workflow_id !== 'number' ||
    !shape.events.includes(String(run.event)) ||
    Date.parse(String(run.updated_at)) < Date.parse(capabilityObservedAt)
  ) {
    throw new Error(
      `${plane} delivery run must be a successful exact-main run completed after plan capability was observed`,
    );
  }
  const workflow = await objectResponse(
    api(token, 'GET', `/repos/${repo}/actions/workflows/${run.workflow_id}`),
    `reading ${plane} workflow identity`,
  );
  if (workflow.path !== shape.path) {
    throw new Error(`${plane} delivery run used the wrong workflow path`);
  }
  const content = await objectResponse(
    api(
      token,
      'GET',
      `/repos/${repo}/contents/sync-standards.local.json?ref=${run.head_sha}`,
    ),
    `reading ${plane} run policy`,
  );
  if (content.encoding !== 'base64' || typeof content.content !== 'string') {
    throw new Error(`${plane} delivery run policy could not be read`);
  }
  const runPolicyRaw = Buffer.from(
    content.content.replace(/\s/gu, ''),
    'base64',
  ).toString('utf8');
  const current = await readSyncPolicy(consumer);
  const temporaryPolicy = parseSyncPolicy(JSON.parse(runPolicyRaw) as unknown);
  if (
    isolationPolicySha256(temporaryPolicy) !== isolationPolicySha256(current)
  ) {
    throw new Error(
      `${plane} delivery run did not use the current isolation policy`,
    );
  }
  const jobsBody = await objectResponse(
    api(token, 'GET', `/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`),
    `reading ${plane} delivery jobs`,
  );
  if (
    !Array.isArray(jobsBody.jobs) ||
    jobsBody.total_count !== jobsBody.jobs.length ||
    !jobsBody.jobs.every(isRecord)
  ) {
    throw new Error(`${plane} delivery jobs response was incomplete`);
  }
  const job = jobsBody.jobs.find((candidate) => candidate.name === shape.job);
  const steps = isRecord(job) && Array.isArray(job.steps) ? job.steps : [];
  if (
    !isRecord(job) ||
    job.conclusion !== 'success' ||
    !shape.steps.every((name) =>
      steps.some(
        (step) =>
          isRecord(step) && step.name === name && step.conclusion === 'success',
      ),
    )
  ) {
    throw new Error(
      `${plane} delivery run did not complete every secret-consuming step`,
    );
  }
  const deployments = await arrayResponse(
    api(
      token,
      'GET',
      `/repos/${repo}/deployments?sha=${run.head_sha}&environment=${encodeURIComponent(environment)}&per_page=100`,
    ),
    `reading ${plane} deployments`,
  );
  const deployment = deployments.find(
    (candidate) =>
      candidate.environment === environment &&
      candidate.ref === 'main' &&
      typeof candidate.id === 'number',
  );
  if (deployment === undefined) {
    throw new Error(
      `${plane} delivery run has no exact-main deployment for ${environment}`,
    );
  }
  const statuses = await arrayResponse(
    api(
      token,
      'GET',
      `/repos/${repo}/deployments/${deployment.id}/statuses?per_page=100`,
    ),
    `reading ${plane} deployment status`,
  );
  if (
    !statuses.some(
      (status) =>
        status.state === 'success' &&
        typeof status.log_url === 'string' &&
        status.log_url.includes(`/actions/runs/${runId}`),
    )
  ) {
    throw new Error(
      `${plane} deployment is not tied to the successful workflow run`,
    );
  }
  return {
    runId,
    workflowId: run.workflow_id,
    workflowPath: shape.path,
    headSha: run.head_sha,
    headRef: 'main',
    event: String(run.event),
    environment,
    deploymentId: deployment.id as number,
    completedAt: String(run.updated_at),
    conclusion: 'success',
  };
};

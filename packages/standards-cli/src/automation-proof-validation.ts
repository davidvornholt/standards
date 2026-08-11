import {
  AUTOMATION_PROOF_FILE,
  AUTOMATION_PROOF_MAX_AGE_MS,
  type AutomationProof,
  isolationPolicySha256,
  readAutomationProof,
} from './automation-proof';
import { resolveGithubRepo } from './github-api';
import type { SyncPolicy } from './sync-policy';

const MINUTES_PER_FUTURE_TOLERANCE = 5;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;
const FUTURE_TOLERANCE_MS =
  MINUTES_PER_FUTURE_TOLERANCE * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;

type PlaneName = 'automation' | 'notifications';

const planeProblems = (
  name: PlaneName,
  policy: SyncPolicy,
  proof: AutomationProof,
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This validator gathers every independent plane mismatch so one run reports the complete proof drift.
): ReadonlyArray<string> => {
  const selected = policy[name];
  if (selected === undefined) {
    return proof.planes[name] === undefined
      ? []
      : [
          `${AUTOMATION_PROOF_FILE}: stale ${name} proof exists without a selected policy plane`,
        ];
  }
  const plane = proof.planes[name];
  if (plane === undefined) {
    return [
      `${AUTOMATION_PROOF_FILE}: missing ${name} environment proof; run bun standards automation verify with admin auth`,
    ];
  }
  const problems: Array<string> = [];
  if (plane.environment.toLowerCase() !== selected.environment.toLowerCase()) {
    problems.push(
      `${AUTOMATION_PROOF_FILE}: ${name} environment does not match policy`,
    );
  }
  if (plane.secretName !== selected.ageKeySecret) {
    problems.push(
      `${AUTOMATION_PROOF_FILE}: ${name} environment secret does not match policy`,
    );
  }
  if (plane.ageRecipient !== selected.ageRecipient) {
    problems.push(
      `${AUTOMATION_PROOF_FILE}: ${name} age recipient does not match policy`,
    );
  }
  if (proof.legacyAgeRecipients.includes(selected.ageRecipient)) {
    problems.push(
      `${AUTOMATION_PROOF_FILE}: ${name} age recipient reuses a legacy CI decryptor identity`,
    );
  }
  if (plane.delivery !== undefined) {
    const expectedPath =
      name === 'automation'
        ? '.github/workflows/standards-sync.yml'
        : '.github/workflows/notify-pause.yml';
    const expectedEvents =
      name === 'automation' ? ['schedule'] : ['issues', 'pull_request_target'];
    if (
      plane.delivery.workflowPath !== expectedPath ||
      !expectedEvents.includes(plane.delivery.event) ||
      plane.delivery.environment.toLowerCase() !==
        selected.environment.toLowerCase() ||
      Date.parse(plane.delivery.completedAt) <
        Date.parse(proof.capabilityObservedAt)
    ) {
      problems.push(
        `${AUTOMATION_PROOF_FILE}: ${name} delivery proof does not prove a post-capability exact-main run`,
      );
    }
  }
  return problems;
};

export const automationProofProblems = async (
  consumer: string,
  policy: SyncPolicy,
  now = Date.now(),
): Promise<ReadonlyArray<string>> => {
  if (policy.automation === undefined && policy.notifications === undefined) {
    return [];
  }
  let proof: AutomationProof | null;
  try {
    proof = await readAutomationProof(consumer);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  if (proof === null) {
    return [
      `${AUTOMATION_PROOF_FILE}: required for isolated workflow planes; generate it with bun standards automation verify using admin auth`,
    ];
  }
  const problems: Array<string> = [];
  const repo = resolveGithubRepo(consumer);
  if (
    repo === null ||
    repo.toLowerCase() !== proof.repository.fullName.toLowerCase()
  ) {
    problems.push(
      `${AUTOMATION_PROOF_FILE}: repository identity does not match the origin remote`,
    );
  }
  if (proof.policySha256 !== isolationPolicySha256(policy)) {
    problems.push(
      `${AUTOMATION_PROOF_FILE}: policy digest is stale; regenerate the proof with admin auth`,
    );
  }
  const observed = Date.parse(proof.observedAt);
  if (
    observed > now + FUTURE_TOLERANCE_MS ||
    now - observed > AUTOMATION_PROOF_MAX_AGE_MS
  ) {
    problems.push(
      `${AUTOMATION_PROOF_FILE}: live environment observation is stale or in the future; regenerate it with admin auth`,
    );
  }
  if (Date.parse(proof.capabilityObservedAt) > observed) {
    problems.push(
      `${AUTOMATION_PROOF_FILE}: capability observation is later than its live environment observation`,
    );
  }
  problems.push(...planeProblems('automation', policy, proof));
  problems.push(...planeProblems('notifications', policy, proof));
  return problems;
};

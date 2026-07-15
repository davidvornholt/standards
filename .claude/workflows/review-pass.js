export const meta = {
  name: 'review-pass',
  description:
    'One bounded review pass: lens reviewers over the diff, adversarial verification of risky findings, one merged structured finding set',
  whenToUse:
    'Invoked by the review-fix skill for its review and verification passes. Args: { baseRef, gateStatus, decisions, lenses: [{ key, charter, notes? }] }. Returns { findings, refuted, skippedLenses, coverage }.',
  phases: [
    { title: 'Review', detail: 'one read-only lens reviewer per lens, full-diff scope' },
    { title: 'Verify', detail: 'refutation attempts for blocking or needs-verification findings' },
  ],
};

// The harness may deliver args as an object or as a JSON-encoded string;
// normalize once so every dereference below is safe.
const input = typeof args === 'string' ? JSON.parse(args) : args;

// The severity and confidence enums mirror the review skill's finding
// categories and confidence labels — renaming either side breaks the contract.
const findingsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'coverage'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        // file/line are recorded when the finding has a natural location, but
        // are not required — some findings (a missing test, a deleted file, a
        // whole-file concern) have no single line, and forcing an anchor would
        // fabricate one that then poisons dedup and verification labels.
        required: ['severity', 'summary', 'evidence', 'confidence'],
        properties: {
          severity: { type: 'string', enum: ['blocking', 'non-blocking', 'nit'] },
          file: { type: 'string', description: 'Repo-relative path, when the finding has one' },
          line: { type: 'integer', minimum: 1, description: 'Anchor line, when the finding has one' },
          summary: { type: 'string', description: 'One-sentence statement of the defect' },
          evidence: { type: 'string', description: 'What was inspected and why this is real' },
          confidence: { type: 'string', enum: ['confirmed', 'needs-verification'] },
        },
      },
    },
    coverage: {
      type: 'string',
      description: 'What was inspected, surfaces enumerated, and focused checks run',
    },
  },
};

const verdictSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reasoning'],
  properties: {
    verdict: { type: 'string', enum: ['upheld', 'refuted', 'uncertain'] },
    reasoning: { type: 'string' },
  },
};

const severityRank = (severity) => {
  if (severity === 'blocking') {
    return 0;
  }
  if (severity === 'non-blocking') {
    return 1;
  }
  return 2;
};

const reviewPrompt = (lens) =>
  [
    'You are a read-only review subagent running one concern lens of a bounded review pass. The review skill in your context is your operating contract — its scope, lens, registry, confidence, and output rules apply; this prompt only parameterizes them.',
    '',
    `Review scope: the full current diff against ${input.baseRef}, per the review skill's scope contract. In a verification pass that base is the pre-fix head, so the diff under review is exactly the fix commits.`,
    '',
    `Concern lens "${lens.key}": ${lens.charter}`,
    ...(lens.notes ? [`Since this lens last ran: ${lens.notes}`] : []),
    '',
    `Deterministic gate status: ${input.gateStatus}. Do not re-run the full repo gate; run only focused checks relevant to this lens.`,
    '',
    'Decisions registry content:',
    input.decisions,
    '',
    'Schema output only; no prose report.',
  ].join('\n');

const locationLabel = (finding) =>
  `${finding.file ?? 'no-file'}:${finding.line ?? 'no-line'}`;

const verifyPrompt = (finding) =>
  [
    'You are a read-only verification subagent. Adversarially verify one review finding: actively try to REFUTE it by inspecting the actual code, its callers, tests, configuration, and installed dependency sources as needed. Do not edit files; do not run the full repo gate; focused probes only.',
    '',
    `Finding under test (severity ${finding.severity}, lens ${finding.lens}, confidence ${finding.confidence}):`,
    `- Location: ${locationLabel(finding)}`,
    `- Claim: ${finding.summary}`,
    `- Claimed evidence: ${finding.evidence}`,
    '',
    `Diff base: ${input.baseRef}; the finding refers to the current working tree.`,
    '',
    'Verdict rules: "refuted" when the claimed defect is not real, cannot occur, or misreads the code — explain the disproof. "upheld" only when you independently confirmed the failure mode. "uncertain" when neither could be established; state exactly what is missing.',
  ].join('\n');

const needsVerification = (finding) =>
  finding.severity === 'blocking' || finding.confidence === 'needs-verification';

const nearDuplicateLineDistance = 3;

// Stable content key: co-located findings with different summaries are distinct
// defects and must not be merged; the same summary from two lenses is one
// finding seen twice. Keying on identity would break across the parallel()
// journal, and keying on file+line alone would silently drop a second defect.
const findingKey = (finding) =>
  `${finding.file ?? ''} ${finding.line ?? ''} ${finding.summary}`;

const lensResults = await pipeline(
  input.lenses,
  (lens) =>
    agent(reviewPrompt(lens), {
      agentType: 'reviewer',
      label: `review:${lens.key}`,
      phase: 'Review',
      schema: findingsSchema,
    }),
  async (result, lens) => {
    // A dead/skipped lens agent returns null. Surface it as an explicit skip so
    // the orchestrator sees a partial fan-out rather than a silently short set.
    if (!result) {
      return { lens: lens.key, skipped: true, coverage: null, findings: [] };
    }
    const findings = result.findings.map((finding) => ({ ...finding, lens: lens.key }));
    const risky = findings.filter(needsVerification);
    log(`lens ${lens.key}: ${findings.length} findings, ${risky.length} sent to verification`);
    // parallel() preserves order, so zip verdicts back by index against the
    // local risky array (whose elements are the same references as `findings`);
    // reading the finding back off the agent result would lose identity across
    // the journal and drop the verdict.
    const verdicts = await parallel(
      risky.map((finding, index) => () =>
        agent(verifyPrompt(finding), {
          agentType: 'reviewer',
          label: `verify:${lens.key}:${index}:${locationLabel(finding)}`,
          phase: 'Verify',
          schema: verdictSchema,
        })),
    );
    const verdictFor = new Map();
    risky.forEach((finding, index) => {
      // A null here means the verify agent itself failed or was skipped —
      // distinct from "never sent to verification" (which stays null on the
      // finding). Mark it so the orchestrator can re-verify rather than trust
      // an unchallenged claim.
      verdictFor.set(
        finding,
        verdicts[index] ?? {
          verdict: 'unverified',
          reasoning: 'verification agent failed or was skipped',
        },
      );
    });
    return {
      lens: lens.key,
      skipped: false,
      coverage: result.coverage,
      findings: findings.map((finding) => ({
        ...finding,
        verdict: verdictFor.get(finding) ?? null,
      })),
    };
  },
);

const results = lensResults.filter(Boolean);
const completed = results.filter((result) => !result.skipped);
const skippedLenses = results
  .filter((result) => result.skipped)
  .map((result) => result.lens);

const upheld = [];
const refuted = [];
for (const result of completed) {
  for (const finding of result.findings) {
    if (finding.verdict?.verdict === 'refuted') {
      refuted.push(finding);
    } else {
      upheld.push(finding);
    }
  }
}

const merged = [];
const mergedByKey = new Map();
for (const finding of upheld) {
  const key = findingKey(finding);
  const existing = mergedByKey.get(key);
  if (existing) {
    if (!existing.lenses.includes(finding.lens)) {
      existing.lenses.push(finding.lens);
    }
    if (severityRank(finding.severity) < severityRank(existing.severity)) {
      existing.severity = finding.severity;
    }
  } else {
    // Drop the singular `lens` in favor of the merged `lenses` array so the
    // returned finding carries one, consistent attribution.
    const { lens, ...rest } = finding;
    const entry = { ...rest, lenses: [lens] };
    mergedByKey.set(key, entry);
    merged.push(entry);
  }
}

for (const finding of merged) {
  if (typeof finding.line !== 'number') {
    continue;
  }
  let nearestLine = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const other of merged) {
    if (
      other === finding ||
      other.file !== finding.file ||
      typeof other.line !== 'number'
    ) {
      continue;
    }
    const distance = Math.abs(other.line - finding.line);
    if (distance <= nearDuplicateLineDistance && distance < nearestDistance) {
      nearestDistance = distance;
      nearestLine = other.line;
    }
  }
  if (nearestLine !== null) {
    finding.nearDuplicateAtLine = nearestLine;
  }
}

merged.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

if (skippedLenses.length > 0) {
  log(`${skippedLenses.length} lens(es) skipped: ${skippedLenses.join(', ')}`);
}
log(`merged: ${merged.length} findings, ${refuted.length} refuted`);

return {
  findings: merged,
  refuted,
  skippedLenses,
  coverage: results.map((result) => ({
    lens: result.lens,
    skipped: result.skipped,
    coverage: result.coverage,
  })),
};

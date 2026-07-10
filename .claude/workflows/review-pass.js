export const meta = {
  name: 'review-pass',
  description:
    'One review-loop pass: lens reviewers over the full diff, adversarial verification of risky findings, one merged structured finding set',
  whenToUse:
    'Invoked by the review-loop skill for each review pass. Args: { passNumber, baseRef, gateStatus, decisions, lenses: [{ key, charter, notes? }] }.',
  phases: [
    { title: 'Review', detail: 'one read-only lens reviewer per lens, full-diff scope' },
    { title: 'Verify', detail: 'refutation attempts for blocking or needs-verification findings' },
  ],
};

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
        required: ['severity', 'file', 'line', 'summary', 'evidence', 'confidence'],
        properties: {
          severity: { type: 'string', enum: ['blocking', 'non-blocking', 'nit'] },
          file: { type: 'string', description: 'Repo-relative path' },
          line: { type: 'integer', minimum: 1 },
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
    'You are a read-only review subagent running one concern lens of a review-loop pass. The review skill in your context is your operating contract — its scope, lens, registry, confidence, and output rules apply; this prompt only parameterizes them.',
    '',
    `Review scope: the full current diff against ${args.baseRef}, per the review skill's scope contract.`,
    '',
    `Concern lens "${lens.key}": ${lens.charter}`,
    lens.notes ? `Since this lens last ran: ${lens.notes}` : '',
    '',
    `Pass number: ${args.passNumber}. Deterministic gate status: ${args.gateStatus}. Do not re-run the full repo gate; run only focused checks relevant to this lens.`,
    '',
    'Decisions registry content:',
    args.decisions,
    '',
    'Schema output only; no prose report.',
  ].join('\n');

const verifyPrompt = (finding) =>
  [
    'You are a read-only verification subagent. Adversarially verify one review finding: actively try to REFUTE it by inspecting the actual code, its callers, tests, configuration, and installed dependency sources as needed. Do not edit files; do not run the full repo gate; focused probes only.',
    '',
    `Finding under test (severity ${finding.severity}, lens ${finding.lens}, confidence ${finding.confidence}):`,
    `- Location: ${finding.file}:${finding.line}`,
    `- Claim: ${finding.summary}`,
    `- Claimed evidence: ${finding.evidence}`,
    '',
    `Diff base: ${args.baseRef}; the finding refers to the current working tree.`,
    '',
    'Verdict rules: "refuted" when the claimed defect is not real, cannot occur, or misreads the code — explain the disproof. "upheld" only when you independently confirmed the failure mode. "uncertain" when neither could be established; state exactly what is missing.',
  ].join('\n');

const needsVerification = (finding) =>
  finding.severity === 'blocking' || finding.confidence === 'needs-verification';

const nearDuplicateLineDistance = 3;

const lensResults = await pipeline(
  args.lenses,
  (lens) =>
    agent(reviewPrompt(lens), {
      agentType: 'reviewer',
      label: `review:${lens.key}`,
      phase: 'Review',
      schema: findingsSchema,
    }),
  async (result, lens) => {
    if (!result) {
      return null;
    }
    const findings = result.findings.map((finding) => ({ ...finding, lens: lens.key }));
    const risky = findings.filter(needsVerification);
    log(`lens ${lens.key}: ${findings.length} findings, ${risky.length} sent to verification`);
    const verdicts = await parallel(
      risky.map((finding) => () =>
        agent(verifyPrompt(finding), {
          agentType: 'reviewer',
          label: `verify:${finding.file}:${finding.line}`,
          phase: 'Verify',
          schema: verdictSchema,
        }).then((verdict) => ({ finding, verdict }))),
    );
    const verdictFor = new Map();
    for (const entry of verdicts) {
      if (entry) {
        verdictFor.set(entry.finding, entry.verdict);
      }
    }
    return {
      lens: lens.key,
      coverage: result.coverage,
      findings: findings.map((finding) => ({
        ...finding,
        verdict: verdictFor.get(finding) ?? null,
      })),
    };
  },
);

const results = lensResults.filter(Boolean);
const upheld = [];
const refuted = [];
for (const result of results) {
  for (const finding of result.findings) {
    if (finding.verdict?.verdict === 'refuted') {
      refuted.push(finding);
    } else {
      upheld.push(finding);
    }
  }
}

const merged = [];
for (const finding of upheld) {
  const exact = merged.find((other) => other.file === finding.file && other.line === finding.line);
  if (exact) {
    exact.lenses.push(finding.lens);
    if (severityRank(finding.severity) < severityRank(exact.severity)) {
      exact.severity = finding.severity;
    }
  } else {
    merged.push({ ...finding, lenses: [finding.lens] });
  }
}
for (const finding of merged) {
  const near = merged.find(
    (other) =>
      other !== finding &&
      other.file === finding.file &&
      Math.abs(other.line - finding.line) <= nearDuplicateLineDistance,
  );
  if (near) {
    finding.nearDuplicateAtLine = near.line;
  }
}
merged.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

log(`pass ${args.passNumber} merged: ${merged.length} findings, ${refuted.length} refuted`);

return {
  findings: merged,
  refuted,
  coverage: results.map((result) => ({ lens: result.lens, coverage: result.coverage })),
};

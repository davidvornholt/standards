export const meta = {
  name: 'review-pass',
  description:
    'One bounded review pass: an adaptive fan-out of one to four Luna Max lens reviewers, merged into one actionable finding set',
  whenToUse:
    'Invoked by the review-fix skill for full review, fix verification, and high-risk repair verification. Args: { passKind, baseRef, gateStatus, decisions, intent, threatModel, lenses: [{ key, charter, exclusions?, notes? }] }. Returns { findings, skippedLenses, coverage }.',
  phases: [
    {
      title: 'Review',
      detail: 'one read-only Luna Max reviewer per non-overlapping lens, full-diff scope',
    },
  ],
};

const input = typeof args === 'string' ? JSON.parse(args) : args;
const reviewPassKind = 'review';
const maximumReviewLenses = 4;
const maximumVerificationLenses = 2;
const maximumLenses =
  input.passKind === reviewPassKind
    ? maximumReviewLenses
    : maximumVerificationLenses;

if (
  !Array.isArray(input.lenses) ||
  input.lenses.length < 1 ||
  input.lenses.length > maximumLenses
) {
  throw new Error(
    `${input.passKind} requires 1-${maximumLenses} non-overlapping lenses.`,
  );
}

const lensKeys = input.lenses.map((lens) => lens.key);
if (new Set(lensKeys).size !== lensKeys.length) {
  throw new Error('Every review lens must have a unique key.');
}

const nullableString = {
  anyOf: [{ type: 'string' }, { type: 'null' }],
};
const nullableInteger = {
  anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }],
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
        required: [
          'decision',
          'impact',
          'evidenceStatus',
          'file',
          'line',
          'summary',
          'evidence',
          'failureScenario',
          'suggestedVerification',
          'question',
          'recommendation',
        ],
        properties: {
          decision: {
            type: 'string',
            enum: ['block', 'defer', 'discard', 'ask'],
          },
          impact: {
            type: 'string',
            enum: ['breakage', 'weakening', 'polish'],
          },
          evidenceStatus: {
            type: 'string',
            enum: ['reproduced', 'demonstrated', 'unverified'],
          },
          file: nullableString,
          line: nullableInteger,
          summary: {
            type: 'string',
            description: 'One-sentence statement of the defect or durable decision',
          },
          evidence: {
            type: 'string',
            description: 'What was executed or observed',
          },
          failureScenario: {
            type: 'string',
            description: 'Concrete practical consequence through a reachable path',
          },
          suggestedVerification: {
            type: 'string',
            description: 'Smallest focused verification that protects the failure class',
          },
          question: {
            ...nullableString,
            description: 'Required only for ask: the one unavoidable maintainer decision',
          },
          recommendation: {
            ...nullableString,
            description: 'Required only for ask: recommended option and why',
          },
        },
      },
    },
    coverage: {
      type: 'string',
      description:
        'Surfaces enumerated for this lens, assumptions made, and focused checks run',
    },
  },
};

const decisionRank = (decision) => {
  if (decision === 'block') {
    return 0;
  }
  if (decision === 'ask') {
    return 1;
  }
  if (decision === 'defer') {
    return 2;
  }
  return 3;
};

const impactRank = (impact) => {
  if (impact === 'breakage') {
    return 0;
  }
  if (impact === 'weakening') {
    return 1;
  }
  return 2;
};

const evidenceRank = (status) => {
  if (status === 'reproduced') {
    return 0;
  }
  if (status === 'demonstrated') {
    return 1;
  }
  return 2;
};

const lensExclusions = (lens) => {
  if (Array.isArray(lens.exclusions)) {
    return lens.exclusions.join('; ');
  }
  return lens.exclusions ?? 'Anything owned primarily by another lens in this pass.';
};

const reviewPrompt = (lens) =>
  [
    'You are one read-only lens reviewer in a bounded review-fix fan-out. The review skill in your context is the operating contract. Read the whole diff for cross-file relationships, but report only findings whose primary failure class belongs to your lens. Other reviewers deliberately cover the other lenses; do not broaden into their work.',
    '',
    `Pass kind: ${input.passKind}.`,
    `Review scope: the full current diff against ${input.baseRef}. For verification passes this base is the pre-fix or pre-repair head, so the diff is exactly the delta being verified.`,
    '',
    'Frozen intent:',
    input.intent,
    '',
    'Frozen threat model:',
    input.threatModel,
    '',
    `Your lens "${lens.key}": ${lens.charter}`,
    `Explicit exclusions: ${lensExclusions(lens)}`,
    `Other lenses running in parallel: ${lensKeys
      .filter((key) => key !== lens.key)
      .join(', ') || 'none'}.`,
    ...(lens.notes ? ['', `Since this lens last ran: ${lens.notes}`] : []),
    '',
    `Deterministic and focused-check status: ${input.gateStatus}. Do not repeat the full repository gate; run only probes needed to demonstrate this lens's concerns.`,
    '',
    'Decisions registry content:',
    input.decisions,
    '',
    'Return one final decision per finding. There is no separate severity:',
    '- block only for a demonstrated, in-intent, materially merge-blocking defect;',
    '- defer for real actionable work outside this PR or below the merge bar;',
    '- discard only for durable refutations, accepted risks, or concerns too low-value to schedule; do not emit every thought;',
    '- ask only when materially different product or architecture outcomes remain unresolved and choosing wrongly would be costly to reverse through a durable contract, data model, ownership/lifecycle boundary, external behavior, or foundational architecture.',
    '',
    'Do not ask about inferable implementation details, reversible choices, local refactors, test shape inside existing infrastructure, or machinery that can be deferred. Prefer the simplest local correction. Recommend at most one minimal regression test per failure class, extend existing tests first, and never propose a new fixture or test harness for one finding.',
    '',
    'For fix-verification and repair-verification, report a block only when the delta failed to close an existing blocker or introduced a new material regression. A defect that reproduces on the base predates this delta and is defer or discard.',
    '',
    'Use question and recommendation only for ask; set them to null otherwise. Use file and line when a natural anchor exists; otherwise set them to null. Schema output only.',
  ].join('\n');

const validateFinding = (finding) => {
  if (
    finding.decision === 'ask' &&
    (!(finding.question && finding.recommendation))
  ) {
    throw new Error('An ask finding must include a question and recommendation.');
  }
  if (
    finding.decision !== 'ask' &&
    (finding.question !== null || finding.recommendation !== null)
  ) {
    throw new Error('Only ask findings may include a question or recommendation.');
  }
};

const lensResults = await pipeline(
  input.lenses,
  (lens) =>
    agent(reviewPrompt(lens), {
      agentType: 'reviewer',
      model: 'gpt-5.6-luna',
      effort: 'max',
      label: `review:${input.passKind}:${lens.key}`,
      phase: 'Review',
      sandbox: 'read-only',
      schema: findingsSchema,
    }),
  (result, lens) => {
    if (!result) {
      return { lens: lens.key, skipped: true, coverage: null, findings: [] };
    }
    result.findings.forEach(validateFinding);
    const findings = result.findings.map((finding) => ({
      ...finding,
      lens: lens.key,
    }));
    log(`lens ${lens.key}: ${findings.length} findings`);
    return {
      lens: lens.key,
      skipped: false,
      coverage: result.coverage,
      findings,
    };
  },
);

const results = lensResults.filter(Boolean);
const completed = results.filter((result) => !result.skipped);
const skippedLenses = results
  .filter((result) => result.skipped)
  .map((result) => result.lens);

const normalizedSummary = (summary) =>
  summary.toLowerCase().replaceAll(/[^\p{Letter}\p{Number}]+/gu, ' ').trim();
const findingKey = (finding) =>
  `${finding.file ?? ''} ${finding.line ?? ''} ${normalizedSummary(finding.summary)}`;

const merged = [];
const mergedByKey = new Map();
for (const result of completed) {
  for (const finding of result.findings) {
    const key = findingKey(finding);
    const existing = mergedByKey.get(key);
    if (!existing) {
      const { lens, ...rest } = finding;
      const entry = { ...rest, lenses: [lens] };
      mergedByKey.set(key, entry);
      merged.push(entry);
      continue;
    }

    if (!existing.lenses.includes(finding.lens)) {
      existing.lenses.push(finding.lens);
    }
    if (decisionRank(finding.decision) < decisionRank(existing.decision)) {
      existing.decision = finding.decision;
      existing.question = finding.question;
      existing.recommendation = finding.recommendation;
    }
    if (impactRank(finding.impact) < impactRank(existing.impact)) {
      existing.impact = finding.impact;
    }
    if (
      evidenceRank(finding.evidenceStatus) <
      evidenceRank(existing.evidenceStatus)
    ) {
      existing.evidenceStatus = finding.evidenceStatus;
      existing.evidence = finding.evidence;
      existing.failureScenario = finding.failureScenario;
      existing.suggestedVerification = finding.suggestedVerification;
    }
    if (existing.decision !== 'ask') {
      existing.question = null;
      existing.recommendation = null;
    }
  }
}

const nearDuplicateLineDistance = 3;
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

merged.sort(
  (left, right) => decisionRank(left.decision) - decisionRank(right.decision),
);

if (skippedLenses.length > 0) {
  log(`${skippedLenses.length} lens(es) skipped: ${skippedLenses.join(', ')}`);
}
log(`merged: ${merged.length} findings from ${completed.length} lens(es)`);

return {
  findings: merged,
  skippedLenses,
  coverage: results.map((result) => ({
    lens: result.lens,
    skipped: result.skipped,
    coverage: result.coverage,
  })),
};

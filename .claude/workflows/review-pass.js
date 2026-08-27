export const meta = {
  name: 'review-pass',
  description:
    'One bounded review pass: a single Luna Max reviewer covers every concern and returns one actionable decision per finding',
  whenToUse:
    'Invoked by the review-fix skill for full review, fix verification, and high-risk repair verification. Args: { passKind, baseRef, gateStatus, decisions, intent, threatModel, concerns: [{ key, charter, notes? }] }. Returns { findings, skipped, coverage }.',
  phases: [
    { title: 'Review', detail: 'one read-only Luna Max reviewer, full-diff scope' },
  ],
};

const input = typeof args === 'string' ? JSON.parse(args) : args;

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
          'concerns',
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
          concerns: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
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
        'Surfaces enumerated for every concern, assumptions made, and focused checks run',
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

const concernText = input.concerns
  .map((concern) =>
    [
      `- ${concern.key}: ${concern.charter}`,
      ...(concern.notes ? [`  Since the previous pass: ${concern.notes}`] : []),
    ].join('\n'),
  )
  .join('\n');

const reviewPrompt = [
  'You are the single read-only reviewer in a bounded review-fix pass. The review skill in your context is the operating contract. Cover every concern below in one traversal of the whole diff; do not spawn or request another reviewer.',
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
  'Concern checklist:',
  concernText,
  '',
  `Deterministic and focused-check status: ${input.gateStatus}. Do not repeat the full repository gate; run only probes needed to demonstrate a concern.`,
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

const result = await agent(reviewPrompt, {
  agentType: 'reviewer',
  model: 'gpt-5.6-luna',
  effort: 'max',
  label: `review:${input.passKind}`,
  phase: 'Review',
  sandbox: 'read-only',
  schema: findingsSchema,
});

if (!result) {
  log('reviewer interrupted');
  return {
    findings: [],
    skipped: true,
    coverage: 'The single reviewer was interrupted before returning coverage.',
  };
}

for (const finding of result.findings) {
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
}

result.findings.sort(
  (left, right) => decisionRank(left.decision) - decisionRank(right.decision),
);

log(`review: ${result.findings.length} findings`);

return {
  findings: result.findings,
  skipped: false,
  coverage: result.coverage,
};

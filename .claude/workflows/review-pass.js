export const meta = {
  name: 'review-pass',
  description:
    'A bounded fan-out of one to four narrow lens reviewers, merged into one finding set',
  whenToUse:
    'Used by review-fix. Args: { passKind, baseRef, gateStatus, decisions, intent, threatModel, lenses, model?, effort? }. Returns { findings, skippedLenses, coverage }.',
  phases: [{ title: 'Review', detail: 'one read-only reviewer per lens' }],
};

const input = typeof args === 'string' ? JSON.parse(args) : args;
const maxLenses = input.passKind === 'review' ? 4 : 2;

if (
  !Array.isArray(input.lenses) ||
  input.lenses.length < 1 ||
  input.lenses.length > maxLenses
) {
  throw new Error(`${input.passKind} requires 1-${maxLenses} lenses.`);
}

const lensKeys = input.lenses.map((lens) => lens.key);
if (new Set(lensKeys).size !== lensKeys.length) {
  throw new Error('Every lens needs a unique key.');
}

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
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
          summary: { type: 'string' },
          evidence: { type: 'string' },
          failureScenario: { type: 'string' },
          suggestedVerification: { type: 'string' },
          question: nullableString,
          recommendation: nullableString,
        },
      },
    },
    coverage: { type: 'string' },
  },
};

const rank = {
  decision: { block: 0, ask: 1, defer: 2, discard: 3 },
  impact: { breakage: 0, weakening: 1, polish: 2 },
  evidence: { reproduced: 0, demonstrated: 1, unverified: 2 },
};

const exclusionsOf = (lens) =>
  Array.isArray(lens.exclusions)
    ? lens.exclusions.join('; ')
    : (lens.exclusions ?? 'failure classes owned by another lens');

const promptFor = (lens) =>
  [
    'The injected review skill is your contract. Read the whole diff, but report only this lens.',
    `Pass: ${input.passKind}. Base: ${input.baseRef}.`,
    `Intent: ${input.intent}`,
    `Threat model: ${input.threatModel}`,
    `Lens ${lens.key}: ${lens.charter}`,
    `Exclude: ${exclusionsOf(lens)}`,
    `Other lenses: ${lensKeys.filter((key) => key !== lens.key).join(', ') || 'none'}`,
    ...(lens.notes ? [`Delta notes: ${lens.notes}`] : []),
    `Gate status: ${input.gateStatus}`,
    `Decisions registry: ${input.decisions}`,
    input.passKind === 'review'
      ? 'Apply the review skill decisions directly.'
      : 'Block only an unresolved original blocker or a material regression introduced by this delta; base-preexisting defects are defer or discard.',
    'Set question and recommendation only for ask; otherwise null. Schema output only.',
  ].join('\n\n');

const validateFinding = (finding) => {
  const hasDecisionBrief = Boolean(
    finding.question && finding.recommendation,
  );
  if ((finding.decision === 'ask') !== hasDecisionBrief) {
    throw new Error('Only ask findings may carry a complete decision brief.');
  }
};

const agentOverrides = {};
if (typeof input.model === 'string' && input.model.trim() !== '') {
  agentOverrides.model = input.model;
}
if (typeof input.effort === 'string' && input.effort.trim() !== '') {
  agentOverrides.effort = input.effort;
}

const lensResults = await pipeline(
  input.lenses,
  (lens) =>
    agent(promptFor(lens), {
      agentType: 'reviewer',
      ...agentOverrides,
      label: `review:${input.passKind}:${lens.key}`,
      phase: 'Review',
      schema: findingsSchema,
    }),
  (result, lens) => {
    if (!result) {
      return { lens: lens.key, skipped: true, coverage: null, findings: [] };
    }
    result.findings.forEach(validateFinding);
    return {
      lens: lens.key,
      skipped: false,
      coverage: result.coverage,
      findings: result.findings.map((finding) => ({
        ...finding,
        lens: lens.key,
      })),
    };
  },
);

const results = lensResults.filter(Boolean);
const skippedLenses = results
  .filter((result) => result.skipped)
  .map((result) => result.lens);

const normalize = (value) =>
  value.toLowerCase().replaceAll(/[^\p{Letter}\p{Number}]+/gu, ' ').trim();
const keyOf = (finding) =>
  `${finding.file ?? ''}:${finding.line ?? ''}:${normalize(finding.summary)}`;

const findings = [];
const byKey = new Map();

for (const result of results.filter((item) => !item.skipped)) {
  for (const finding of result.findings) {
    const key = keyOf(finding);
    const existing = byKey.get(key);
    if (!existing) {
      const { lens, ...rest } = finding;
      const merged = { ...rest, lenses: [lens] };
      byKey.set(key, merged);
      findings.push(merged);
      continue;
    }

    if (!existing.lenses.includes(finding.lens)) {
      existing.lenses.push(finding.lens);
    }
    if (
      rank.decision[finding.decision] < rank.decision[existing.decision]
    ) {
      existing.decision = finding.decision;
      existing.question = finding.question;
      existing.recommendation = finding.recommendation;
    }
    if (rank.impact[finding.impact] < rank.impact[existing.impact]) {
      existing.impact = finding.impact;
    }
    if (
      rank.evidence[finding.evidenceStatus] <
      rank.evidence[existing.evidenceStatus]
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

findings.sort(
  (left, right) =>
    rank.decision[left.decision] - rank.decision[right.decision],
);

if (skippedLenses.length > 0) {
  log(`skipped lenses: ${skippedLenses.join(', ')}`);
}
log(`merged ${findings.length} findings from ${results.length - skippedLenses.length} lenses`);

return {
  findings,
  skippedLenses,
  coverage: results.map(({ lens, skipped, coverage }) => ({
    lens,
    skipped,
    coverage,
  })),
};

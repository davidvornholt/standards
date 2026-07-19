export const meta = {
  name: 'review-pass',
  description:
    'One bounded review pass: lens reviewers over the diff, one merged structured finding set',
  whenToUse:
    'Invoked by the review-fix skill for its review and verification passes. Args: { baseRef, gateStatus, decisions, lenses: [{ key, charter, notes? }] }. Returns { findings, skippedLenses, coverage }.',
  phases: [
    { title: 'Review', detail: 'one read-only lens reviewer per lens, full-diff scope' },
  ],
};

// The harness may deliver args as an object or as a JSON-encoded string;
// normalize once so every dereference below is safe.
const input = typeof args === 'string' ? JSON.parse(args) : args;

// The severity enum and the evidence/unverified contract mirror the review
// skill — renaming either side breaks the contract.
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
        // fabricate one that then poisons dedup.
        required: ['severity', 'summary', 'evidence'],
        properties: {
          severity: { type: 'string', enum: ['blocking', 'non-blocking', 'nit'] },
          file: { type: 'string', description: 'Repo-relative path, when the finding has one' },
          line: { type: 'integer', minimum: 1, description: 'Anchor line, when the finding has one' },
          summary: { type: 'string', description: 'One-sentence statement of the defect' },
          evidence: { type: 'string', description: 'What was executed or observed that demonstrates the failure' },
          unverified: {
            type: 'string',
            description:
              'The one missing out-of-checkout observation (external system behavior, production state, or human intent question), when the review skill permits it',
          },
        },
      },
    },
    coverage: {
      type: 'string',
      description: 'What was inspected, surfaces enumerated, and focused checks run',
    },
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
    'You are a read-only review subagent running one concern lens of a bounded review pass. The review skill in your context is your operating contract — its scope, lens, registry, evidence, and output rules apply; this prompt only parameterizes them.',
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

const nearDuplicateLineDistance = 3;

// Stable content key: co-located findings with different summaries are distinct
// defects and must not be merged; the same summary from two lenses is one
// finding seen twice. Keying on file+line alone would silently drop a second
// defect.
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
  (result, lens) => {
    // A dead/skipped lens agent returns null. Surface it as an explicit skip so
    // the orchestrator sees a partial fan-out rather than a silently short set.
    if (!result) {
      return { lens: lens.key, skipped: true, coverage: null, findings: [] };
    }
    const findings = result.findings.map((finding) => ({ ...finding, lens: lens.key }));
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

const merged = [];
const mergedByKey = new Map();
for (const result of completed) {
  for (const finding of result.findings) {
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
log(`merged: ${merged.length} findings`);

return {
  findings: merged,
  skippedLenses,
  coverage: results.map((result) => ({
    lens: result.lens,
    skipped: result.skipped,
    coverage: result.coverage,
  })),
};

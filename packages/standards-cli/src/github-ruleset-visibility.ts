// Turns unverifiable ruleset fields into gate failures. This module owns both
// the wording of an invisible field and the test for which field it is, so the
// two cannot drift apart: an earlier version formatted the message in one
// module and recovered the signal by parsing the suffix in another, where a
// reformat would have silently stopped the bypass-actor fallback from firing.

import {
  ADMIN_VISIBILITY_ADVICE,
  unverifiableProblem,
} from './github-command-shared';
import {
  BYPASS_ACTORS_KEY,
  type UnverifiableRulesetField,
} from './github-ruleset-diff';

const SCOPE = 'ruleset field(s)';

export const isHiddenBypassActors = (
  field: UnverifiableRulesetField,
): boolean => field.key === BYPASS_ACTORS_KEY;

const fieldLabel = (field: UnverifiableRulesetField): string =>
  `ruleset "${field.name}": ${field.key}`;

// What the GraphQL bypass-actor fallback established, so the advice can tell a
// failed request from a permission gap. `countedNames` holds the live rulesets
// GraphQL did answer a count for.
export type BypassCountOutcome = {
  readonly countedNames: ReadonlySet<string>;
  readonly failure: string | null;
};

// Rulesets can be unverifiable for reasons other than a hidden bypass list, in
// which case the fallback is never called.
export const GRAPHQL_NOT_CONSULTED: BypassCountOutcome = {
  countedNames: new Set(),
  failure: null,
};

// The generic "read access to repository administration" remedy is
// unactionable for brokered CI here: REST withholds this field from a GitHub
// App installation token at every permission level, so widening the App only
// broadens the blast radius while the gate stays red.
const INSTALLATION_DEAD_END =
  "A GitHub App installation token cannot read bypass_actors over REST at any permission level, so widening the App's permissions will not help";

const COUNT_MATCHED_ADVICE = `GitHub reports the declared number of bypass actors but withholds their identities, so the repository is probably fine and only a local run with admin auth can confirm it. ${INSTALLATION_DEAD_END}`;

const NOTHING_ANSWERED_ADVICE = `Neither REST nor the GraphQL bypass-actor count answered for the ruleset(s) listed, so nothing at all is known about who may bypass them; verify locally with admin auth. ${INSTALLATION_DEAD_END}`;

// The two no-failure remedies differ per ruleset, so the fields are partitioned
// rather than reported under whichever advice one of them happened to match: a
// ruleset GraphQL never answered for must never be described as probably fine
// because a sibling ruleset was counted.
const hiddenBypassActorsProblems = (
  fields: ReadonlyArray<UnverifiableRulesetField>,
  outcome: BypassCountOutcome,
): ReadonlyArray<string> => {
  if (outcome.failure !== null) {
    return unverifiableProblem(
      SCOPE,
      fields.map(fieldLabel),
      `The GraphQL bypass-actor count did not answer (${outcome.failure}), so this is a failed request rather than a permission gap: re-run the check, and if it keeps failing verify locally with admin auth`,
    );
  }
  const counted = fields.filter((field) =>
    outcome.countedNames.has(field.name),
  );
  const unanswered = fields.filter(
    (field) => !outcome.countedNames.has(field.name),
  );
  return [
    ...unverifiableProblem(
      SCOPE,
      counted.map(fieldLabel),
      COUNT_MATCHED_ADVICE,
    ),
    ...unverifiableProblem(
      SCOPE,
      unanswered.map(fieldLabel),
      NOTHING_ANSWERED_ADVICE,
    ),
  ];
};

export const rulesetVisibilityProblems = (
  unverifiable: ReadonlyArray<UnverifiableRulesetField>,
  outcome: BypassCountOutcome,
): ReadonlyArray<string> => {
  const hidden = unverifiable.filter(isHiddenBypassActors);
  const others = unverifiable.filter((field) => !isHiddenBypassActors(field));
  return [
    ...unverifiableProblem(
      SCOPE,
      others.map(fieldLabel),
      ADMIN_VISIBILITY_ADVICE,
    ),
    ...hiddenBypassActorsProblems(hidden, outcome),
  ];
};

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

const hiddenBypassActorsAdvice = (
  fields: ReadonlyArray<UnverifiableRulesetField>,
  outcome: BypassCountOutcome,
): string => {
  if (outcome.failure !== null) {
    return `The GraphQL bypass-actor count did not answer (${outcome.failure}), so this is a failed request rather than a permission gap: re-run the check, and if it keeps failing verify locally with admin auth`;
  }
  if (fields.some((field) => outcome.countedNames.has(field.name))) {
    return `GitHub reports the declared number of bypass actors but withholds their identities, so the repository is probably fine and only a local run with admin auth can confirm it. ${INSTALLATION_DEAD_END}`;
  }
  return `Neither REST nor the GraphQL bypass-actor count answered for this ruleset, so nothing at all is known about who may bypass it; verify locally with admin auth. ${INSTALLATION_DEAD_END}`;
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
    ...unverifiableProblem(
      SCOPE,
      hidden.map(fieldLabel),
      hiddenBypassActorsAdvice(hidden, outcome),
    ),
  ];
};

## Quality gates

Don't weaken a quality gate to make a change pass. Explain every inline suppression where it appears. Use a configuration exception only where a rule can't apply, scoped to the affected path and rule.

## Change policy

Don't build backwards compatibility by default. Code in these repositories has no consumers outside them, so migrate every call site and delete the old shape in the same change.

Ask before choosing product intent or another costly, durable direction. In the question, explain what's at stake and where each option leads, and recommend one before presenting technical evidence.

Disagree openly when an instruction, plan, or rule seems wrong, and say what you would do instead. Recommend the better option even when it's a bigger change than was asked for.

Before merging a pull request of any size, run `review-fix` if you judge that a reviewer could find a bug in it that someone would otherwise run into. Standards syncs are exempt, because a consumer can't change synced files.

## Writing style

Write for a reader who has no background on the task and hasn't read the code, whether that's the user, a reviewer, or the next agent. Agents write most code now, so nobody holds the full background.

Write plainly and directly, in literal wording and complete sentences that are easy to follow. Avoid mannered prose, stock phrases, and jargon where plain words say the same thing, and don't compress sentences into fragments to save words.

Use sentence case for reader-facing text, including Markdown headings.

Don't hard-wrap Markdown prose.

## Documentation and instructions

Agents are the main readers of documentation, skills, instructions, and prompts. Both reading and reasoning cost tokens, so keep a sentence only when it saves more thinking than it costs to read, such as a decision agents would otherwise get wrong or work out again on every run. Simplify by removing decisions and branches rather than compressing sentences, and before adding a rule, check whether changing an existing one would do. Give the reason for a rule that isn't obvious, and state each fact once. Keep history and status in PRs and issues, and cut documentation in the same change that makes it stale.

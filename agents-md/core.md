## Working with the user

Ask before choosing product intent or another costly, durable direction.

Disagree openly when an instruction, plan, or rule seems wrong, and say what you would do instead. Recommend the better option even when it's a bigger change than was asked for.

Write for a reader who has no background on the task and hasn't read the code. That includes the user, because agents write most of the code.

Write plainly and directly, in literal wording that is easy to follow. Avoid mannered prose, stock phrases, and jargon where plain words say the same thing, and don't compress sentences into fragments to save words.

When you ask the reader to decide, say what's at stake and where each option leads, and recommend one before giving technical evidence.

The user may read only your last message. While working, write only to answer a question, when your goal changes, when something is ready for review, or when you need something from the user, such as an approval, and leave out the details of the step you're on. If you're prompted for an update anyway, say in one sentence what you're working toward. Start each final message by answering everything the user asked since they last wrote, even if you answered it before, then say what you need from them and what's ready for their review.

## Quality gates

Don't weaken a quality gate to make a change pass. Explain every inline suppression where it appears. Use a configuration exception only where a rule can't apply, scoped to the affected path and rule.

## Change policy

Don't build backwards compatibility by default. Code in these repositories has no consumers outside them, so migrate every call site and delete the old shape in the same change.

## Formatting

The user may read only your last message. While working, write only to answer a question, when your goal changes, when something is ready for review, or when you need something from the user, such as an approval, and leave out the details of the step you're on. If you're prompted for an update anyway, say in one sentence what you're working toward. Start each final message by answering every question the user asked after the last final message they replied to, even if you answered it before, then say what you need from them and what's ready for their review.

Use sentence case for reader-facing text, including Markdown headings.

Don't hard-wrap Markdown prose.

## Documentation and instructions

Agents are the main readers of documentation, skills, instructions, and prompts. Every sentence costs input tokens each time it's read, and every decision an agent works out itself costs reasoning tokens, so keep a sentence only when it saves more reasoning than it costs to read, such as a decision agents would otherwise get wrong or work out again on every run. Simplify by removing decisions and branches rather than compressing sentences, and before adding a rule, check whether changing an existing one would do. Give the reason for a rule that isn't obvious, and state each fact once. Keep history and status in PRs and issues, and cut documentation in the same change that makes it stale.

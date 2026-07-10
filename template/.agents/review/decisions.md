# Review decisions registry

Durable, already-litigated review decisions. How reviewers must treat entries and when loops append them is defined in the `review` and `review-loop` skills.

Entry format: heading `### D-NNN (date, status) — title`, where status is `decided` or `open`, followed by the decision and its rationale in prose. Entries are never edited silently; superseding an entry means a new entry that references the old id.

## Entries

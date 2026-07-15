# Review-loop ledger corpus: longitudinal research notes

Twelve ledgers from every known run of the `review-loop` skill (May 2026 – July 2026), collected 2026-07-15 from gitignored `.agents/tmp/` directories across `prosabridge`, `fesk`, `mail-archive`, and `mail-mcp`, plus the operator's archive. Together with `../POST-MORTEM.md` (the PR #28 failure that retired the skill), this is the only longitudinal record of review-agent behavior across model generations in these repos.

Filenames are normalized to `<date>-<repo>-<slug>.md` by ledger content; the fesk ledgers were recovered from `mail-archive/.agents/tmp/` and the operator's archive but describe `@fesk/web` work.

## Corpus index

| Ledger | Model (as recorded) | Passes | Findings by pass | Duration | Outcome |
|---|---|---:|---|---|---|
| 2026-05-29 prosabridge translationbench | not recorded | 3 | 9 → 3 → 0 | ~1 day | converged; 3 discarded, 3 deferred |
| 2026-05-29 prosabridge readme-links | not recorded | 1 | 0 | ~1 min | converged; fan-out skipped for narrow diff |
| 2026-05-30 prosabridge current-changes | not recorded | 3 | 13 → 1 → 0 | ~29 min | converged; 1 finding escalated to user, left open |
| 2026-05-30 prosabridge current-diff | not recorded | 2 | 5 → 0 | ~11 min | converged |
| undated prosabridge architecture-db-admin-a11y | not recorded | n/a | 5 fixed | n/a | follow-up loop consuming prior deferrals |
| 2026-06-11 fesk strict-gates | **GPT-5.5 xhigh** | 6 | 11 → 3 → 9 → 4 → 14 → 0 | ~11 h | converged, but final fan-out aborted by usage limits; closed on local review + green gate |
| 2026-06-12 fesk current-diff (two models) | **GPT-5.5 xhigh (p1–3), Claude Fable 5 high (p4–8)** | 3 + 5 | 5.5: ~10 → ~6 → 0; Fable on same diff: **17** → 5 → 1 → 1(+nit) → 0 | ~2.5 h + ~1.5 h | both segments converged — see "natural experiment" |
| 2026-06-13 mail-archive pr-preview | not recorded | 3 | 10 → 6 → 0 | ~49 min | converged |
| 2026-06-24 mail-archive current-diff | not recorded | 2 | 4 → 0 | ~11 min | converged; 1 refuted by live probe |
| 2026-07-02 mail-archive worker-sync | not recorded | 2 | 2 → 0 | ~6 min | converged |
| 2026-07-03 mail-archive current-changes | not recorded | 5 | 13 → 7 → 0 → 0 → 0 | ~45 min | converged; ~5 discarded/deferred |
| 2026-07-11 mail-mcp mcp-contract | **GPT-5/Codex** | 4 | 6 → 2 → 0 → 0 | ~22 min | converged under the dry-counter rule (2 consecutive clean) |
| *(2026-07-13 standards PR #28)* | **GPT-5.6 Sol high** | **39, force-stopped** | 9 → … → 1–3/pass, never 0 | **~46 h, non-terminating** | see `../POST-MORTEM.md` |

## Finding 1: every pre-PR-28 loop converged, because diff growth damped

Twelve for twelve. Every loop grows its own diff — fixes are commits, so a "clean pass" is only reachable if fix rounds shrink faster than they add reviewable surface. In every ledger they did: fix rounds decayed from double-digit findings to single digits to documentation tails within 2–5 passes, adding tens of lines per round against diffs of hundreds to thousands. Convergence was damped feedback, never absence of growth. PR #28 is the same loop with the feedback sign flipped: subsystem-scale fix rounds (up to +9.6k lines in a single round) added surface faster than passes could clear it. Later passes in the historical corpus consistently shrank toward documentation and config tails. Orchestrators dispositioned actively: discards and deferrals appear throughout ("churn without benefit", "speculative refinement", "out of loop scope", "needs product clarification"), and two loops escalated findings to the user rather than fixing them. PR #28's signature behaviors — 200x diff growth and 289/289 findings accepted with zero discards — do not appear anywhere in this corpus. They were new.

## Finding 2: the natural experiment of 2026-06-12

The two-model ledger is a controlled comparison nobody planned. GPT-5.5 xhigh reviewed a diff and reached a clean pass at pass 3 — converged under the then-current "stop when the reviewer reports no findings" rule. Hours later, Claude Fable 5 high ran fresh eyes over the *byte-identical* diff and pass 4 produced **17 valid findings and 12 discards**, including a real open redirect (`returnTo=/\evil.com`; WHATWG URL treats `\` as `/`) and non-atomic multi-statement writes producing false audit rows.

Interpretation: a weak-model "clean pass" certifies the model's recall ceiling, not the code. The stopping signal "the reviewer went quiet" was always a measurement of the reviewer.

Equally important: the Fable segment *also converged* (passes 4–8: 17 → 5 → 1 → 1 → 0) — because the skill then allowed **delta-scoped convergence reviews**: after the full fan-out, later passes reviewed only each fix delta with a single reviewer. A strong model can go quiet on a 40-line delta even though it never goes quiet on a 37k-line diff.

## Finding 3: the stopping-rule timeline, and how hardening caused the failure

- **2026-05-15**: skill born with single-clean-pass convergence ("stop when the reviewer reports no findings"). Works — weak reviewers exhaust.
- **2026-06-12**: the natural experiment above demonstrates single-clean-pass under-measures.
- **2026-07-10**: dry counter introduced — two consecutive clean **full fresh fan-outs** required; partial/delta passes no longer count ("one clean pass is a sample, not proof"). A direct, reasonable reaction to 06-12.
- **2026-07-11**: mcp-contract converges under the dry counter in 4 passes — small diff, findings genuinely exhaust, rule looks validated.
- **2026-07-13**: PR #28. GPT-5.6 Sol high, a CLI/security-flavored diff, and a fixer able to write ~9.5k coherent lines per repair round. The dry counter never leaves 0/2 across 39 passes; force-stopped after ~46 h.

The failure required all four factors at once, and the corpus shows each factor's absence elsewhere:

1. **Reviewer whose finding stream doesn't exhaust** on a growing diff (GPT-5.5 exhausted; Fable exhausted on deltas; GPT-5.6 Sol on a growing full diff did not).
2. **Full-fan-out-only convergence** (the 07-10 hardening removed the delta-scoped termination path that let the 06-12 Fable segment finish).
3. **Unconstrained in-place fixing** (every repair enlarged the next pass's diff; pass 17 alone added 9.5k lines).
4. **Disposition atrophy** (the review-pass workflow's adversarial refutation pre-stamped findings as "upheld", and the orchestrator treated upheld as to-fix; the discard muscle exercised in every ledger here recorded zero discards in 39 passes).

Single-clean-pass under-measures with weak reviewers; clean-twice over-demands with strong ones. No finding-count threshold works across model generations, because reviewer silence is a statement about the reviewer.

## Finding 4: what pass counts actually measured

Across the corpus, multi-pass yield was real but front-loaded: pass 2 typically surfaced 30–60% of pass 1's count (stochastic-subset recall), pass 3 approached zero. With stronger models the front-loading intensifies: on 2026-06-12, Fable's single pass 4 found everything GPT-5.5 had found across three passes, plus 17 more. In PR #28, ~97% of all findings were defects in loop-authored fixes — i.e., with a strong reviewer, the first well-lensed pass captures essentially all material findings in the *original* work, and later passes harvest either an immaterial depth-tail or defects the loop itself introduced.

Corollary: additional passes with strong models are not harmful per se — they are harmful when coupled to an unfiltered mandate to fix everything found, because that converts tail-noise into new code, new surface, and new defects.

## Consequences (encoded in the `review-fix` skill, standards PR #33)

- One full lens fan-out for finding; materiality and scope judged against a contract frozen before findings exist; real-but-adjacent findings become issues, not commits.
- Delta-scoped review is **kept as verification** (base = pre-fix head, so the reviewed diff is exactly the fix commits) and **rejected as convergence evidence** — a quiet delta pass verifies fixes; it certifies nothing about the whole PR, and doesn't need to, because the certificate is the residual-risk report, not silence.
- No convergence condition at all: the cycle is structurally bounded (review → fix → verify → stop).

## Related artifacts

- `../POST-MORTEM.md` — the PR #28 failure analysis (this branch).
- standards PR #28 (closed), PR #32 (salvage), PR #33 (`review-fix`), issue #34 (bounded sync-policy follow-up).
- Skill lineage: born in fesk `3279a07` (2026-05-15); dry counter in standards `13d7d9a` (2026-07-10); retired 2026-07-15.

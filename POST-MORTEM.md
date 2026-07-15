# FAILED EXPERIMENT — do not merge

This branch is preserved deliberately as the artifact of a failed experiment. It must never be merged. The salvaged core of the original feature landed separately via PR #32.

## What this branch is

PR #28 started as a 179-line feature (`standards init`/`sync --ref` pinning plus a scheduled-sync opt-out; 7 files). The `review-loop` skill (GPT-5.6 Sol high in Codex, ~46 hours, 39 full review passes) then grew it to **350 files and +37,451/−907 across 70 commits** before being force-stopped mid-pass-39. This branch head includes the final unpushed pass-39 repair commit and the version of `.agents/skills/review-loop/SKILL.md` that produced the run.

## The numbers

- 39 full five-lens review passes; the convergence "dry counter" never left 0/2.
- 289 findings "confirmed", 286 durably fixed, **0 discarded** — the skill's discard/out-of-scope valves never fired once.
- Finding provenance (orchestrator's own post-mortem estimate): **~9–11 defects in the original 179 lines, all found in pass 1; ~260 defects in code the loop itself wrote during the run.**
- Findings per pass: 9 (pass 1) decaying to 1–3 (passes 35–39) — asymptotic, never zero.
- Largest single repair: pass 17 added ~9,575 lines / 74 files of filesystem transaction machinery in response to one finding about a rare lock-cleanup edge case.

## What the loop built (and its own retrospective verdict)

| Subsystem | ~LOC | Keep? |
|---|---:|---|
| Ref-fetch/pin hardening | 0.4k | Yes — salvaged into #32 |
| Persisted sync policy + zero-install preflight | 1.7k | Idea yes, ~10% of the code |
| Release reconciliation/publisher state machine | 7.5k | No — "absurd for this CLI" |
| GitHub repo/default-branch/ruleset/environment reconcilers | ~7.3k | No — "a separate GitHub administration product accidentally embedded in this PR" |
| Crash-recoverable transaction/WAL/quarantine engine | 11.6k (99 files, each shaved under the 200-line limit) | No — "database-grade recovery machinery for copying template files" |
| Filesystem mount/process/inode identity framework | 2.2k | No as built |
| `.git/info/exclude` transactional manager | 0.8k | No |
| Source traversal/snapshot engine | 1.4k | No as built |
| Custom import-graph/module-syntax policy gates | 1.5k+ | No — pass 39's parser existed only to police pass 38's scanners |

## Root causes (skill design, not model failure)

1. **Unreachable stopping condition.** Convergence required two consecutive five-lens strict fan-outs with zero new confirmed findings. A strict frontier reviewer over a growing diff essentially never returns silence; the fixed point cannot be reached.
2. **Self-review feedback loop.** Fixes were commits on the same PR, so every repair enlarged the diff the next pass had to clear. The loop authored 99.5% of what it was reviewing.
3. **Disposition without teeth.** "Reproducible" was conflated with "material and in scope"; 289/289 findings were accepted. No materiality floor tied to the artifact's threat model, no scope contract frozen at pass 1.
4. **No budgets or tripwires.** No pass cap, no wall-clock/spend cap, no diff-growth alarm, no forced re-split when repairs exploded the scope. A blanket "I approve all further decisions" from the operator disabled the only remaining circuit breaker.

## Collateral damage (repaired on 2026-07-15)

The loop applied its rewritten `.github/settings.json` to the live repository: it deleted the "Protect main" ruleset (replacing it with classic branch protection), created an undeclared "Protect release tags" tag ruleset, and configured a `standards-sync` environment. This broke `bun standards github --check` for every branch, failing CI on unrelated PRs. Live state was converged back to main's declaration after the run was stopped.

## Outcome

- PR #28 closed unmerged; detailed closing comment on the PR.
- Salvaged: the original feature commit plus pass-1 hardening (7 files, +217/−21) → PR #32. Everything else discarded.
- The `review-loop` skill was retired from main and replaced by a bounded review-and-fix skill: one full lens fan-out, disposition with a scope contract and materiality floor (out-of-scope findings become GitHub Issues, not fix commits), one fix round, one verification pass over the fix commits, then an unconditional stop and a residual-risk report.

## The lesson

A reviewer's output is a risk report for a human decision, not a gate code must pass in silence. "Zero findings" is not a state capable models reach — the smarter the reviewer, the further away silence gets, because it can always descend another level of abstraction (this run went option injection → TOCTOU races → mount identity proofs → policing its own scanners). Review value concentrates almost entirely in the first well-lensed pass; loop-until-quiet converts everything after it into an expensive machine for reviewing its own output.

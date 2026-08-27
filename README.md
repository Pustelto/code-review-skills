# code-review

A thorough, evidence-first code review skill for [Claude Code](https://claude.com/claude-code).

It reviews a branch or an MR the way a paranoid staff engineer does: start from the diff, form
specific questions about what the change could break, and read the narrowest code that answers each
one. Nothing is "fine" because types compile or tests pass — a claim counts only when the code that
proves it has been read and cited as `file:line`.

Read-only. It analyses and reports; it never edits code and never posts a comment anywhere.

On the [Martian Code Review Bench](https://codereview.withmartian.com) it scores an adjusted F1 of
**0.80** — second of the 44 tools on the dashboard — at a golden recall of 0.69. One of the findings
the benchmark scored as a false positive turned out to be a real Grafana auth bypass, reported in
production nine months later and fixed as the review proposed. See [docs/benchmarks.md](docs/benchmarks.md).

---

## Two conditions for a valid run

**1. Run it on Opus.** On Sonnet it finds roughly half as much and misses real bugs — measured, not
assumed. Same PRs, same config: golden recall **0.73 → 0.45**, and **71 → 18** confirmed real bugs
outside the golden set. Sonnet produces a *tidier* review, which is exactly why the gap is easy to
miss.

**2. Run it from the main agent, never nested inside another agent.** The review dispatches its own
subagents — a blind hazard classifier and a reviewer fan-out. Nested subagent spawning is unreliable
across Claude Code environments, so a review launched from inside another agent silently loses both
and still looks complete.

## Install

```bash
git clone https://github.com/<you>/code-review-skills.git
ln -s "$PWD/code-review-skills/code-review" ~/.claude/skills/code-review
```

Then in Claude Code:

```
/code-review
/code-review feat/my-branch
/code-review https://github.com/org/repo/pull/1234
/code-review --audit          # append the evidence tables
```

Requirements: **Node** on `PATH` (for the static pre-pass — no Python, no network, grammars are
vendored) and optionally `gh` / `glab` to pull PR/MR discussions.

## What it does

Six stages, in one turn, ending in a single message:

1. **Intake** — get the diff, read *every* changed file in full, pull the PR/MR description and the
   existing review threads (a comment where a human said "intentional" binds the review — it stops
   the skill re-litigating a decision your team already made).
2. **Static pre-pass** — a vendored tree-sitter tool computes, in code, the off-diff files that
   depend on the changed symbols and the resources this change reads that another flow destroys.
   Deterministic, no model involved. It is what makes "nothing else touches this" checkable.
3. **Hazard declaration** — five universal hazard classes (cross-file contract, async/ordering,
   resource lifecycle, state exhaustiveness, security boundary), each declared YES/NO with
   `file:line` evidence on *both* sides of the boundary. A blind classifier subagent declares them
   independently first, so a hazard can't be waved away by the same blind spot that missed it.
4. **First-pass review + dispatch** — the orchestrator reviews first, then hands the surfaces it
   can't close itself to fully-briefed reviewer subagents (file contents pre-loaded; reviewers are
   leaf nodes and never spawn more agents).
5. **Synthesis** — cross-reference the findings, look for compound risks, calibrate confidence,
   drop what a linter would have caught.
6. **Verdict** — severity floors set the bar, centrality to the change sets the rank.

Every gate produces an artifact, and the artifacts are checked before the verdict is emitted. Where
coverage was incomplete — a file not read, a delegation not traced, the pre-pass unavailable — it
prints a **trust caveat** rather than quietly rounding up to "looks good".

## Output

One single final message, emitted only after every dispatched reviewer has returned.

| Flag | Output |
|---|---|
| *(none)* | Human-readable review, ending at the verdict: summary → findings by tier → open questions → what's done well → what needs a human → verdict. |
| `--audit` | Appends the audit trail: static pre-pass, verbatim classifier verdict, delegation trace, hazard declaration, coverage. |
| `--findings` | Appends a marker-delimited `REVIEW_FINDINGS` block for tools that anchor findings back onto a diff. |
| `--json` | Emits only a JSON object (`schema: "code-review/v1"`) — no prose. |

Flags change **only what is printed**. Every stage, artifact and gate runs either way, because the
gates are what make the verdict worth anything. Trust caveats print regardless.

## Repo-specific focus (optional)

If your repo ships a review-guidance doc, the skill reads it and treats it as an additional review
dimension. It looks for `$CODE_REVIEW_OVERLAY` first, then `docs/code-review.md` — a tool-agnostic
location any agentic reviewer can share. Repo guidance can *raise* priority; it can never silence a
defect it forgot to mention.

## Known limitations

**Strong on correctness, weak on design.** Bug-finding is a local property — a diff checked against
itself and its call-sites. "Is this the right abstraction?" is a judgement about the codebase's
future, and this skill, like every AI reviewer measured, is markedly weaker there. It is good at
broken callers, edge cases, error paths, races, resource lifecycle, contract changes and missing
tests. It is thin on whether the design survives six months. **Keep a human on design review.**

**It is not cheap.** A full review on Opus fans out subagents and reads a lot of code.

## Acknowledgements

This skill is a synthesis, not an invention.

- **[Cursor's `thermo-nuclear-review`](https://github.com/cursor/plugins/blob/main/thermos/skills/thermo-nuclear-review/SKILL.md)**
  and
  [`thermo-nuclear-code-quality-review`](https://github.com/cursor/plugins/blob/main/cursor-team-kit/skills/thermo-nuclear-code-quality-review/SKILL.md)
  (MIT) — the breaking-functionality mandate is quoted near-verbatim; also the "trace end-to-end /
  total confidence / no unfinished research" anti-false-positive clauses, the cross-package-breakage
  / feature-leak / devex-breakage axes, and agreement-weighted synthesis.
- **[Agent Field PR-AF](https://github.com/Agent-Field/pr-af)**
  ([write-up](https://agentfield.ai/blog/ai-native-code-review)) — the cross-reference resolver for
  compound findings, the adversary and coverage-gate ideas (tested here, not kept — see
  [docs/benchmarks.md](docs/benchmarks.md)), and the `honest_compare.py` adjusted scorer used in the
  evaluation.
- **[Martian Code Review Bench](https://github.com/withmartian/code-review-benchmark)** — the
  external evaluation this design was measured against.
- **[The Code Review Pyramid](https://www.morling.dev/blog/the-code-review-pyramid/)** — Gunnar
  Morling, CC BY-SA 4.0. The dimension taxonomy traces back to it, and its "automate the automatable"
  principle is why this skill refuses to flag anything a linter would catch.
- Two internal review skills at **Ataccama** contributed the severity/confidence separation and the
  agent summary contract (subagents return distilled findings, never raw file dumps).

## License

MIT — see [LICENSE](LICENSE).

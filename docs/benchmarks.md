# Benchmarks

How this skill was measured, what the numbers mean, and where they came from.

## The benchmark

[Martian Code Review Bench](https://github.com/withmartian/code-review-benchmark) (offline track) scores an AI reviewer's findings against human-curated "golden" comments on real merged OSS PRs. 44 tools are on the public [dashboard](https://codereview.withmartian.com).

**10 of its 50 PRs were run** — across 5 repos and 5 languages (Keycloak/Java, Sentry/Python, cal.com/TypeScript, Grafana/Go, discourse-graphite/Ruby). Running the subset rather than the full 50 was a cost decision, not a methodological one.

## Two scorings, two different answers

**Standard scoring** counts only golden comments. Golden sets hold 2–6 comments per PR, so every real bug a reviewer finds _outside_ that set is counted as a false positive. A thorough reviewer is punished by construction.

**Adjusted scoring** ([Agent Field's](https://github.com/Agent-Field/pr-af) rescoring, used here via their `honest_compare.py`) sends each non-golden finding to a conservative judge and credits the ones that are real bugs. Same bar for every tool.

| Scoring                           | Precision | Recall   | F1       |
| --------------------------------- | --------- | -------- | -------- |
| Standard (golden-only)            | 0.13      | 0.69     | 0.22     |
| **Adjusted (real bugs credited)** | **≈0.95** | **0.69** | **0.80** |

Golden recall is 0.69 either way — the scoring philosophy, not the reviewer, decides whether thoroughness reads as a virtue or a defect.

Under adjusted scoring that **0.80 places second of the 44 tools on the dashboard**, behind cubic-dev (0.88) and ahead of cubic-v2 (0.75), augment (0.74), coderabbit (0.66) and Claude Code's built-in review (0.56). Under standard scoring the same reviews rank ~41st.

| Tool                   | Adj. P    | Recall   | Adj. F1  |
| ---------------------- | --------- | -------- | -------- |
| cubic-dev              | 0.99      | 0.80     | 0.88     |
| **this skill (Opus)**  | **≈0.95** | **0.69** | **0.80** |
| cubic-v2               | 1.00      | 0.60     | 0.75     |
| augment                | 0.97      | 0.60     | 0.74     |
| coderabbit             | 0.91      | 0.51     | 0.66     |
| claude-code (built-in) | 0.95      | 0.40     | 0.56     |

## Confirmed in the wild

On [`grafana/grafana#79265`](https://github.com/grafana/grafana/pull/79265) the skill raised a Critical the golden set did not contain: a cache poison that let a blocked device bypass the anonymous-device limit on refresh. The benchmark scored it a false positive.

Nine months later the same bug was [reported in production](https://github.com/grafana/grafana/issues/93755) and [fixed](https://github.com/grafana/grafana/pull/94218) essentially as the review proposed (`localCache.Delete(key)` plus an `errutil.Unauthorized` on the limit path).

## Model matters more than anything else

Same PRs, same configuration, 5-PR subset:

| Model  | Golden recall | Real non-golden bugs found |
| ------ | ------------- | -------------------------- |
| Opus   | 0.73          | 71                         |
| Sonnet | 0.45          | 18                         |

Sonnet produces a _tidier_ review — fewer findings, higher standard-scoring precision — which is exactly why the gap is easy to miss. The grafana bug above is caught by Opus and missed by Sonnet. This is why the README states running on Opus as a condition, not a recommendation.

## What did NOT help

Measured, and dropped:

- **More reviewers.** Eight reviewers instead of four _fragmented_ the review — golden recall fell 0.45 → 0.36 while raw finding count rose.
- **An adversary pass that deletes findings.** It over-challenged and killed real bugs; recall dropped. If revisited, an adversary should _downgrade confidence_, not delete.
- **A literal-correctness "deepen" pass.** Near-zero usable yield on the PR it was tested against: its wheelhouse is symbol-level mistakes, while the bugs that matter here are temporal and cross-file.
- **Self-consistency and coverage gates behind an LLM merge.** They fed more real findings in, but the LLM synthesis merge is lossy and dropped them again — including goldens. Any recall lever needs a lossless aggregation step to survive.
- **Per-stack rule packs.** The skill used to bundle reference files of per-language best practice (TypeScript/React, Kotlin/Java, GraphQL, Helm, Gradle, CI) that Stage 1c loaded for the detected stack. An A/B on three PRs where those files applied (cal.com #10600 and #8087 — TypeScript; Keycloak #37429 — Java), each reviewed once with the rule packs and once with them deleted, found:

  |                         | With rule packs     | Without             |
  | ----------------------- | ------------------- | ------------------- |
  | Findings (3 PRs)        | 22 · 12 · 10        | 22 · 9 · 10         |
  | Golden comments matched | 8 / 10              | 9 / 10              |
  | Verdicts                | all _needs changes_ | all _needs changes_ |

  Every Critical was found by both arms. The remaining differences tracked how many reviewer subagents each run happened to dispatch, not the rule packs. Loading was unreliable on top of that: one run never read the file for its stack and still reported it as loaded. The content was mostly best practice a capable model already applies, so it was dropped — a repo that wants its own pins can supply them through the repo overlay, where they are actually specific to something.

## Known limitation the numbers hide

**Strong on correctness, weak on design.** Bug-finding is a local property — a diff checked against itself and its call-sites. "Is this good code?" is a judgement about the codebase's future, and this skill, like every AI reviewer measured, is markedly weaker there. SWE-PRBench finds frontier models catch only 15–31% of human-flagged issues from a diff alone. Keep a human on design review.

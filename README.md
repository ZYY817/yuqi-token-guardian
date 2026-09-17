# Token Guardian — archived

**Status: abandoned.** Built on a wrong premise; kept public as a postmortem.
Measured evidence lives in [POSTMORTEM.md](POSTMORTEM.md). [中文](README.zh.md)

A plugin for DeepSeek Harness (dsh) that tried to stop DeepSeek's runaway
thinking — the failure mode where a model loops for hours and burns tens of
millions of tokens — by compacting replayed `reasoning_content`, deduping tool
results, and lowering reasoning effort on routine steps.

## Why it failed

- **The fuse that couldn't blow.** The only mechanisms that could actually stop
  a runaway — hard token caps and loop detection — shipped opt-in and advisory.
  A non-converging model ignores "please converge" nudges. Nothing in the suite
  could physically kill a burning session; the one thing the problem required
  was the one thing deliberately excluded.
- **Wrong metric.** The −98.6% headline counts *replayed characters* — billed at
  prefix-cache price (~93% hit rate, measured). Real dollar savings were never
  demonstrated; on the gateway route, ablation showed no attributable delta.
- **Flagship mechanism was net-negative.** Switching effort mid-session changes
  the request prefix — measured `cached_tokens=0` per shift. On a long session,
  one shift re-bills the entire history at full price to save a few hundred
  cached tokens.
- **Wrong layer.** Reasoning replay is a serializer policy in the harness. The
  fix belongs upstream or in an HTTP proxy — not in a plugin bound to the
  internal APIs of a release-candidate tool.
- **Premise didn't hold where it was built.** The dev gateway stripped reasoning
  before forwarding and couldn't differentiate effort levels. Discovered *after*
  the plugins were written — the plan said probe first; we didn't.

## What's still valid

- `sweep` — replace finished reasoning+tool groups near the history tail with a
  summary. Verified on the official route: `reasoning_content` → 0, all
  requests 200, ~93% cache preserved.
- `max_tokens` fuse — a real hard stop against runaway thinking; truncates
  exactly at the cap.
- The cost model: `uncached-prefix × full price + cached-prefix × cache price +
  output × full price`. Priority order: fewer round-trips > prefix stability >
  content trimming.

## If you actually have this problem

Don't install this. Set `reasoningEffort` to low/medium and a `max_tokens`
ceiling — two config lines cover most of the real bill.

MIT. Code kept for reference; no maintenance planned.

<sub>This README and the postmortem were condensed with AI assistance from the
original working notes.</sub>

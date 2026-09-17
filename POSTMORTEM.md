# Postmortem — why this project failed

> This document was condensed with AI assistance from the project's original
> working notes and measurement logs.

## Goal

Stop DeepSeek's runaway thinking — the failure mode where a model loops for
hours and burns tens of millions of tokens (documented real case: 4h / ~30M) —
and the related problem of reasoning history being replayed in full on every
agent step.

## Measured facts (wire-level evidence)

| Fact | Evidence |
|---|---|
| On the official route, historical `reasoning_content` is replayed into every request body | packet capture: prompt 55K→85K and climbing |
| ~93% of replayed content is served from prefix cache and billed at cache-read price | `usage.cached_tokens` |
| Changing thinking/effort params mid-session → `cached_tokens=0`; the whole prefix is re-billed at full price | packet capture |
| `effort=off` → `thinking:{type:'disabled'}`; generation truly off (0 chars) | packet capture |
| `max_tokens` is a server-side hard truncation — physically caps a runaway planning step | measured truncation at exactly the set value |
| Replacing a whole "reasoning + tool calls" group with a summary → all requests 200, replay → 0 | official route, measured |
| Routine steps at max effort only think ~100-160 chars — the model self-regulates | multi-run measurement |
| Gateway-style routes strip reasoning before forwarding and barely differentiate effort levels | curl probes |

## Why it failed

- **Built before probing.** The dev environment (a gateway route) never
  exhibited the problem; the real target environment was only measured at the
  end, after an API key arrived.
- **Wrong metric.** Optimized "replayed characters" — a stream already billed
  at cache price — instead of the bill. Headline −98.6% did not translate into
  demonstrated dollar savings.
- **Net-negative core mechanism.** Mid-session effort switches invalidate the
  prefix cache; on long sessions the cost exceeds the savings.
- **Safety theater.** The mechanisms that could stop a runaway (hard budget,
  physical kill) shipped opt-in and advisory; a non-converging model ignores
  advice.
- **Wrong layer.** The problem lives in the harness serializer and the model
  itself; a third-party plugin can only be a workaround whose lifetime depends
  on the owner never fixing it.

## What remains true (reusable)

- Agent cost model: `uncached-prefix × full + cached-prefix × cache-rate +
  output × full`. Priority: fewer round-trips > prefix stability > trimming.
- The only effective user-side fix is two config lines: lower `reasoningEffort`,
  set a `max_tokens` ceiling.
- If a general tool is ever built, it belongs at the HTTP proxy layer — not in
  any harness's internal plugin API.

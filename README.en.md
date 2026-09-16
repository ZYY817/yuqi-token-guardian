# Token Guardian

[中文](README.md)

In one task, the agent re-sent 1.65 million characters of its own old thinking. This plugin cuts that to 23K.

In DeepSeek thinking mode, every step re-sends all previous reasoning verbatim and bills for it again. The fix here is simple: replace spent reasoning with a summary — keep the conclusions, stop re-mailing the transcript. No changes to official code. Measured on the official API: −98.6% replayed reasoning, task quality unchanged.

| | without | with plugin |
|---|---|---|
| re-sent old reasoning | 1,645,757 chars | 23,176 chars |
| request body | grew to 286KB | steady ~78KB |
| task outcome | completed | completed |

The test task was real work: build a backtracking regex engine from scratch, write assertions, run them — not a toy prompt.

## Install

```sh
dsh --profile <profile> --patch suite.patch.yml
```

`--patch` applies to that run only. For a permanent install, merge `suite.patch.yml` into a profile's `cordis.patch.yml` — patches are per-profile: install into a profile and it applies there; add it to every profile if you want it everywhere.

The default config is the recommended config. Nothing to tune after install.

Verified on `dsh 0.1.5-rc.2`. Ships as compiled `.js` — any dsh build can load it.

## How it works

Old reasoning gets replaced by a summary before it's sent again. The summary keeps conclusions, actions taken, and result previews; what disappears is the verbatim re-transmission.

Features are layered by how much they can hurt a task:

**Deletes redundancy only — on by default**

- `sweep` — whole reasoning groups become summaries
- `dedupe` — repeated reads of the same file collapse to a one-line pointer
- `prune` — oversized tool results shrink in place; the original file is still re-readable

**Advisory only — on by default**

- `shape` — once per turn: don't re-derive settled conclusions, write plans to a file
- `loops` — detects circling / over-budget turns and nudges the model to converge; the model can ignore it
- `batch` — hints at batching when the model reads files one step at a time
- `effort` — routine steps drop from max to low; a reduction, not a shutdown

**Can truncate — off by default**

- `caps` — hard ceilings on reasoning output. Opt in only if runaway thinking is a real concern

## Configuration

Everything lives in the `config` block of `suite.patch.yml`; each section is independent:

```yaml
config:
  loops: { enabled: false }                # turn off a single feature
  caps: { planningMaxTokens: 32000 }       # hard ceiling (can truncate — opt in deliberately)
  sweep: { distill: true }                 # summaries become a model-written state note; costs one cheap call per sweep
  sweep: { keepLatest: 1 }                 # never compact the newest reasoning group
```

## Where it helps most

The official DeepSeek direct route benefits most — reasoning is billed and replayed there for real. Gateways that forward thinking traces benefit the same way. If a gateway strips thinking before forwarding, gains are smaller: upstream never saw the reasoning, and the plugin mainly relieves local context pressure.

## Known costs

- Saves tokens, not time. How long the model thinks is not the plugin's business
- Summaries are lossy: conclusions stay, reasoning detail goes. When a task needs "why did I rule that out", the model may re-derive it — costs a little, answer stays correct. Enable `distill` if that matters
- The originals aren't deleted — they stay in the local session log; they just stop being sent

## Roadmap

- **Recall mechanism**: summaries are lossy because one note can't hold everything. Next step is a `recall` tool — originals stay in the local log, the model fetches them back when needed. Pay only when used
- **Better distillation**: e.g. explicitly recording approaches tried and abandoned

## In this repo

```
plugins/token-guardian.js   the plugin — compiled artifact, single file, zero deps (install this)
plugins/token-guardian.ts   TypeScript source
suite.patch.yml             install entry point
思维链token问题定位分析.md   full analysis: root causes, design, every measurement, per-claim evidence levels
RESULTS.md                  sanitized experiment data
```

Every claim in the analysis doc is tagged verified / inferred / unverified — including our own bugs the tests caught.

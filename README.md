<div align="center">

# Token Guardian

**On the official DeepSeek API, one task re-sent 1.65M characters of reasoning the model had already produced — every request paying for old thinking again. This plugin cuts that to 23K.**

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![tested on](https://img.shields.io/badge/dsh-0.1.5--rc.2-green.svg)]()
[![measured](https://img.shields.io/badge/reasoning%20replay-%E2%88%9298.6%25-brightgreen.svg)](RESULTS.md)

English · [中文](README.zh.md)

</div>

In DeepSeek thinking mode, every agent step re-sends all previous reasoning verbatim — and bills for it again. Token Guardian replaces spent reasoning with a summary: conclusions stay, re-transmission stops. No changes to official code; measured on the official API, task quality unchanged.

| | without | with plugin |
|---|---|---|
| re-sent old reasoning | 1,645,757 chars | **23,176 chars** |
| request body | grew to 286KB | steady ~78KB |
| task outcome | completed | completed |

The test task was real work — a backtracking regex engine built from scratch, with assertions the model wrote and ran itself.

## 🚀 Install

```sh
dsh --profile <profile> --patch suite.patch.yml
```

`--patch` applies to that run only. For a permanent install, merge `suite.patch.yml` into a profile's `cordis.patch.yml` — patches are per-profile, so install into whichever profiles should have it.

The default config is the recommended config. Nothing to tune.

Verified on `dsh 0.1.5-rc.2`. Ships as compiled `.js` — any dsh build can load it.

## 🧠 How it works

Old reasoning gets replaced by a summary before it's sent again. The summary keeps conclusions, actions taken, and result previews — what disappears is the verbatim re-transmission.

Features are layered by how much they can hurt a task:

**🗑️ Deletes redundancy only — on by default**

- `sweep` — whole reasoning groups become summaries
- `dedupe` — repeated reads of the same file collapse to a one-line pointer
- `prune` — oversized tool results shrink in place; the original file is still re-readable

**💬 Advisory only — on by default**

- `shape` — once per turn: don't re-derive settled conclusions, write plans to a file
- `loops` — detects circling / over-budget turns and nudges the model to converge; the model can ignore it
- `batch` — hints at batching when the model reads files one step at a time
- `effort` — routine steps drop from max to low; a reduction, not a shutdown

**✂️ Can truncate — off by default**

- `caps` — hard ceilings on reasoning output. Opt in only if runaway thinking is a real concern

## ⚙️ Configuration

Everything lives in the `config` block of `suite.patch.yml`; each section is independent:

```yaml
config:
  loops: { enabled: false }                # turn off a single feature
  caps: { planningMaxTokens: 32000 }       # hard ceiling (can truncate — opt in deliberately)
  sweep: { distill: true }                 # summaries become a model-written state note; costs one cheap call per sweep
  sweep: { keepLatest: 1 }                 # never compact the newest reasoning group
```

## 🎯 Where it helps most

The official DeepSeek direct route benefits most — reasoning is billed and replayed there for real. Gateways that forward thinking traces benefit the same way. If a gateway strips thinking before forwarding, gains are smaller: upstream never saw the reasoning, and the plugin mainly relieves local context pressure.

## ⚠️ Known costs

- Saves tokens, not time. How long the model thinks is not the plugin's business
- Summaries are lossy: conclusions stay, reasoning detail goes. When a task needs "why did I rule that out", the model may re-derive it — costs a little, answer stays correct. Enable `distill` if that matters
- The originals aren't deleted — they stay in the local session log; they just stop being sent

## 🗺️ Roadmap

- **Recall mechanism** — summaries are lossy because one note can't hold everything. Next step is a `recall` tool: originals stay in the local log, the model fetches them back when needed. Pay only when used
- **Better distillation** — e.g. explicitly recording approaches tried and abandoned

## 📁 In this repo

```
plugins/token-guardian.js   compiled plugin — single file, zero deps (install this)
plugins/token-guardian.ts   TypeScript source
plugins/metrics-logger.*    optional observability plugin (needs config.out)
suite.patch.yml             install entry point
思维链token问题定位分析.md   full analysis: root causes, design, measurements, evidence levels
RESULTS.md                  sanitized experiment data
```

Every claim in the analysis doc is tagged verified / inferred / unverified — including the bugs our own tests caught.

## 📄 License

[MIT](LICENSE)

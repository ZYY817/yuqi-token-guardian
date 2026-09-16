<div align="center">

# Token Guardian

**On the official DeepSeek API, a single task replayed 1.65M characters of reasoning the model had already produced — every request billed for old thinking again. Token Guardian cuts that to 23K.**

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![tested on](https://img.shields.io/badge/dsh-0.1.5--rc.2-green.svg)]()
[![measured](https://img.shields.io/badge/reasoning%20replay-%E2%88%9298.6%25-brightgreen.svg)](RESULTS.md)

English · [中文](README.zh.md)

</div>

In DeepSeek's thinking mode, every agent step re-sends the complete reasoning history and pays for it again. Token Guardian compacts finished reasoning into bounded summaries before it is replayed: conclusions, tool calls, and result previews are preserved — what stops is the verbatim re-transmission. No upstream code changes; measured end-to-end on the official API with task quality preserved.

<table width="100%">
<thead><tr><th width="34%"></th><th width="33%">without</th><th width="33%">with plugin</th></tr></thead>
<tbody>
<tr><td>replayed reasoning</td><td>1,645,757 chars</td><td><b>23,176 chars (−98.6%)</b></td></tr>
<tr><td>request body</td><td>grew to 286KB</td><td>steady ~78KB</td></tr>
<tr><td>task outcome</td><td>completed</td><td>completed</td></tr>
</tbody>
</table>

The benchmark was a real task — a backtracking regex engine built from scratch, with assertions the model wrote and executed itself.

## 🚀 Install

```sh
dsh --profile <profile> --patch suite.patch.yml
```

`--patch` applies to a single run. For a permanent install, merge `suite.patch.yml` into a profile's `cordis.patch.yml` — patches are scoped per profile, so it activates only where you add it.

The default configuration is the recommended one; nothing needs tuning after install. Verified on `dsh 0.1.5-rc.2`. Ships as compiled `.js` — loadable by any dsh build.

## 🧠 How it works

Each finished reasoning group is replaced in place by a bounded summary: what was concluded, which tools were called, and previews of their results. The original reasoning stays in the local session log — it simply stops being transmitted.

Every mechanism is classified by how much it can affect task quality:

**🗑️ Removes redundancy only — on by default**

- `sweep` — historical reasoning groups are replaced by summaries
- `dedupe` — identical repeated tool results collapse to a pointer
- `prune` — oversized tool results are trimmed; the source file remains re-readable

**💬 Advisory only — on by default**

- `shape` — once per turn, reminds the model not to re-derive settled conclusions and to write plans to a file
- `loops` — detects repeated reasoning signatures, same-tool streaks, no-progress stretches, and over-budget turns; injects a converge reminder the model may ignore
- `batch` — suggests batching when the model reads files one step at a time
- `effort` — routine steps run at `low` effort instead of the session level; a reduction, not a shutdown

**✂️ Can truncate — off by default**

- `caps` — hard ceilings on reasoning output. Opt in only when runaway thinking is a real concern; self-disables after repeated truncations

## ⚙️ Configuration

All controls live in the `config` block of `suite.patch.yml`; each section is independent:

```yaml
config:
  loops: { enabled: false }                # disable a single feature
  caps: { planningMaxTokens: 32000 }       # hard ceiling (can truncate — opt in deliberately)
  sweep: { distill: true }                 # summaries become a model-written state note; one cheap call per sweep
  sweep: { keepLatest: 1 }                 # never compact the newest reasoning group
```

## 🎯 Where it helps most

The official DeepSeek route benefits most — reasoning is genuinely billed and replayed there. Gateways that forward thinking traces see the same effect. Where a gateway strips thinking before forwarding, gains are smaller: upstream never received the reasoning, and the plugin mainly relieves local context pressure.

## ⚠️ What it costs

- Saves tokens, not wall-clock time — the model's thinking depth is not the plugin's to control
- Summaries are lossy: conclusions survive, reasoning detail does not. If a task needs "why was this approach ruled out", the model may re-derive it — a small extra cost, not a correctness loss. Enable `distill` for higher-fidelity notes
- Nothing is deleted — originals remain in the local session log; they just stop being sent

## 🗺️ Roadmap

- **Recall mechanism** — summaries are lossy because one note cannot hold everything. Planned: a `recall` tool so the model can fetch original reasoning from the local log on demand — pay only when used
- **Better distillation** — e.g. explicitly recording approaches tried and abandoned

## 📁 In this repo

```
plugins/token-guardian.js   compiled plugin — single file, zero deps
plugins/token-guardian.ts   TypeScript source
plugins/metrics-logger.*    optional observability plugin (requires config.out)
suite.patch.yml             install entry point
思维链token问题定位分析.md   full analysis: root causes, design, measurements, per-claim evidence levels
RESULTS.md                  sanitized experiment data
```

Every claim in the analysis document is tagged verified / inferred / unverified — including the defects our own tests caught.

## 📄 License

[MIT](LICENSE)

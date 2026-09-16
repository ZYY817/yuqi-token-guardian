<div align="center">

# Token Guardian

**在 DeepSeek 官方接口实测：一个任务中，模型将已产生的思考重复发送了 165 万字符 —— 每轮请求都在为旧思考重新计费。本插件将其降至 2.3 万字符。**

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![tested on](https://img.shields.io/badge/dsh-0.1.5--rc.2-green.svg)]()
[![measured](https://img.shields.io/badge/reasoning%20replay-%E2%88%9298.6%25-brightgreen.svg)](RESULTS.md)

[English](README.md) · 中文

</div>

DeepSeek 思考模式下，agent 的每一步都会把完整思考历史重新发送并再次计费。Token Guardian 在回放前将已完成的思考压缩为有界摘要：结论、工具调用与结果预览全部保留，被移除的只是逐字重发本身。不改动官方代码；在官方 API 上端到端实测，任务质量与基线一致。

| | 裸跑 | 装插件后 |
|---|---|---|
| 重发的旧思考 | 1,645,757 字符 | **23,176 字符（-98.6%）** |
| 请求体积 | 涨到 286KB | 稳定在 ~78KB |
| 任务结果 | 完成 | 完成 |

测试任务是真实工作 —— 从零实现一个带回溯的正则表达式引擎，断言由模型自写自测。

## 🚀 安装

```sh
dsh --profile <profile> --patch suite.patch.yml
```

`--patch` 只对本次运行生效。长期使用可将 `suite.patch.yml` 合入某个 profile 的 `cordis.patch.yml` —— patch 按 profile 生效，装进哪个就在哪个启用；需要全模式生效则每个 profile 各加一份。

默认配置即推荐配置，安装后无需调整。已在 `dsh 0.1.5-rc.2` 上验证；发布的是编译好的 `.js`，任意版本的 dsh 均可加载。

## 🧠 原理

每段已完成的思考组被就地替换为一条有界摘要：保留结论、发起的工具调用与结果预览；原始思考仍留存在本地 session 日志中 —— 只是不再被发送。

所有机制按对任务质量的影响分三层：

**🗑️ 只删冗余，默认开启**

- `sweep` — 历史思考组整组替换为摘要
- `dedupe` — 参数完全相同的重复工具结果折叠为一行指针
- `prune` — 超大工具结果就地剪枝，原文件仍可回读

**💬 仅建议不强制，默认开启**

- `shape` — 每轮注入一次：不重复推导已定结论，计划落盘到文件
- `loops` — 检测思考签名重复、同名工具连发、连续无产出步与超预算轮，注入收敛提醒；模型可自行判断
- `batch` — 模型逐文件单读时提示合并调用
- `effort` — 机械步骤的思考档由 max 降为 low，是降档而非关闭

**✂️ 可能截断，默认关闭**

- `caps` — 思考量硬上限。仅在确有失控风险时启用；连续截断后自动解除封顶

## ⚙️ 配置

全部开关位于 `suite.patch.yml` 的 `config` 段，各机制相互独立：

```yaml
config:
  loops: { enabled: false }                # 单独关闭某机制
  caps: { planningMaxTokens: 32000 }       # 硬上限（可能截断，请谨慎开启）
  sweep: { distill: true }                 # 摘要改为模型自写的状态笔记，每次清扫多一次低成本调用
  sweep: { keepLatest: 1 }                 # 最新一组思考永不压缩
```

## 🎯 适用场景

官方 DeepSeek 直连收益最大 —— 该路由下思考真实计费、真实回放。转发思维链的网关同理。若网关在上游前已剥离思维链，收益相对有限：上游本就没有收到思考，插件主要缓解本地上下文压力。

## ⚠️ 已知的代价

- 节省的是 token 成本而非耗时 —— 模型思考深度不在插件控制范围内
- 摘要是有损的：保留结论、丢弃推理细节。当任务需要"此前为何排除某方案"时，模型可能重新推导 —— 成本略增，正确性不受影响。在意可开启 `distill`
- 原文并未删除 —— 仍保存在本地 session 日志，仅停止发送

## 🗺️ 后续计划

- **召回机制** —— 摘要有损的根源是一条摘要无法承载全部细节。计划为模型提供 `recall` 工具：原文留存本地日志，需要时由模型按需取回，用到才付费
- **蒸馏摘要改进** —— 例如显式记录"尝试过但放弃的路径"

## 📁 仓库内容

```
plugins/token-guardian.js   编译产物，单文件零依赖
plugins/token-guardian.ts   TypeScript 源码
plugins/metrics-logger.*    可选观测插件（需自配 config.out）
suite.patch.yml             安装入口
思维链token问题定位分析.md   完整分析：根因、设计、每轮实测，结论逐条标证据等级
RESULTS.md                  脱敏后的实测数据汇总
```

分析文档中每条结论均标注【已验证 / 推断 / 未验证】，包括测试抓出的我们自身的缺陷。

## 📄 许可证

[MIT](LICENSE)

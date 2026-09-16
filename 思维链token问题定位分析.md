# DSH 思维链 Token 消耗 —— 问题定位分析

> 目标：解释"一个问题思考后吃 1-200K、1M 上下文经常压缩"的机制根因，找出**不改官方代码**前提下可下手的插件扩展点。

## 0. 实测基线（你的环境）

从 `~/.dsh/sessions/--F-deepseek-harness--/` 最近一次 "say hi" 会话挖出的真实数据：

| 项 | 值 | 说明 |
|---|---|---|
| provider | `my-gateway`（pi-ai 适配器，`api: anthropic-messages` → your-gateway.example 网关） | 非官方 deepseek 直连 |
| model | `deepseek-v4.1-flash` | |
| contextWindow | **262,144**（≈256K，不是 1M） | 该路由上报的窗口 |
| 首次请求 inputTokens | **12,470** | 系统提示 + 工具 schema 的固定开销 |
| 该步 outputTokens | 12 | 无 reasoning 块（这次没触发思考） |

**12K 起步价**：每个请求还没算对话内容，光 system prompt + 工具定义就 1.2 万 token，且每步重发。

## 1. 思维链在 harness 里的完整生命周期

```
模型生成  reasoning-delta chunk ──┐
                                 ▼
提交     assistant/message 事件（message.content 含 reasoning block
        + data.stream 内嵌原始流）→ 追加进 session log（不可变）
                                 │
请求构造  session.deriveMessages() ── 投影 surface 节点
        → options.messages（deepFreeze，冻结）
        → llm/stream waterfall（只读观察点）
        → adapter.serializeAssistant()
              reasoning block → wire 的 reasoning_content 字段
        → HTTP 请求
                                 │
压力     tokenMeter.measure() 计价 → 超过 contextWindow×0.8
        → compaction-basic 调 LLM 总结 → 区间 replace → 只留 16% 原文
```

## 2. 定位到的放大点（按对"烧 token"的贡献排序）

### A. effort 在整个 turn 内不变 —— 工具驱动步也在深度思考 ★主因

`agent/request` waterfall 解析出的 `reasoningEffort` 对整个 turn 的所有 step 生效。agent 任务里绝大多数 step 是"看工具结果→调下一个工具"的机械步，却和首步（真正需要规划的）用同一档。`max` 档下每一步都巨量思考 → 这就是"一个问题 1-200K"的主要生成端来源。

- 证据：`packages/llm/llm/src/call-config.ts`（reasoningEffort 是 request-header 态）；`agent.ts:518` seedConfig 从持久 header 恢复 effort。
- 你的路由上：logged header 里**没有 reasoningEffort** → pi-ai 模型条目未配 `reasoningEfforts` → 当前**连 effort 控制面都没接上**，纯靠服务端默认。

### B. `reasoning_content` 全量回放 —— 输入端 O(ΣCoT) 累积

`llm-deepseek/src/serialize.ts:202-235`：每条带 reasoning 的 assistant 消息，其**完整**思维链在之后每个请求里以 `reasoning_content` 重发。N 步任务里第 k 步的思考会被摄入 N−k 次。

- 官方 API 只**要求** tool-call 轮回放（thinking_mode.mdx）；其它轮 DeepSeek 服务端忽略 —— harness 选择全量发是为了让跨供应商网关能哈希恢复 thinking signature（serialize.ts:228-232 注释明说这是有意为之）。
- pi-ai/anthropic-messages 路径同理（thinking block + signature 回放），且 Anthropic 协议里回放 thinking **计输入计费**。

### C. 架构封死：assistant 消息不可被外科手术改写

`surface.ts:274`：`assistant/message` **禁止**携带 `sourceEventSeqs`（内嵌 stream 的一致性保护）→ surface replace 需要 sourceEventSeqs → **assistant 节点无法像 tool/result 那样被定点裁剪**。`llm/stream` 处 messages 冻结 + `deriveMessages()` desync invariant（agent-loop/src/invariant.ts:40）→ 请求侧改写也封死。

**含义：想减少回放，只有两条合法路 —— 少生成（A），或整段压缩（D）。**

### D. compaction 触发晚、留得少

`compaction-basic`：thresholdRatio 0.8 → 262K 窗口下 ≈ 210K 才压缩；retainRatio 0.16 → 压完只留 ~42K 原文。思考洪流到阈值 → 压缩（本身又是一次 LLM 调用）→ 丢掉 84% 细节 → 模型可能重新推理已做过的工作 → 双重浪费。"经常压缩"的感觉 = A+B 把窗口快速灌满的后果。

### E. 每步重发的固定开销

实测 ~12K/请求（system prompt + 全部工具 schema）。`time-context` 类插件若挂载，每步还追加注入消息进历史。步数多的会话里这是稳定的背景税。

## 2.5 补充：另外三个结构性问题

排查完整链路后，除 A/B/C 外还有这些放大点：

### F. 没有"思考预算"概念 —— 只有档位，没有上限

harness 的旋钮只有 effort 档（off/low/high/max）和 maxTokens（总输出上限，砍它会把正文也截断）。**没有任何按步限制思考 token 量的机制**。pi-ai 侧其实有 `thinkingBudgets`（档位→budget_tokens 映射，Anthropic `thinking.budget_tokens`），但需要在模型条目里显式配置 —— 你的 `my-gateway` 路由没配，等于没有。

### G. 治理全部阈值门控 —— 不撞墙不治理 ★隐蔽但重要

`compaction-basic` 里 `toolResultPruner.pruneSession()` **只在两种情况下跑**：(1) tokenMeter 计量 ≥ 80% 阈值；(2) provider 真的报 context-overflow 错误。平时不管工具结果多大、思考多长，都全额占着窗口 —— 没有任何"平时就勤打扫"的机制。`pruneSession` 本身是 public 的，只是没人主动调它。

### H. 无反馈闭环 —— effort 是开环的

选定的 effort 在执行中永不根据"这步实际上需不需要想"调整。而现成信号都在：`tools/result` 的错误率、guard 包的 repeat-tool 循环检测、`agent/request-error`、step 序号。**控制论意义上这是个开环系统 —— 这正是插件能补的位置。**

（前缀税见 E；`ctx.tools.restrict()` 是现成的"渐进披露"机制，可按任务收窄可见工具集，但没有插件做自动收窄 —— 可作为后续优化项。）

## 3. 可下手的插件扩展点（不动官方）

| 方案 | 扩展点 | 治什么 | 收益/风险 |
|---|---|---|---|
| **P1 闭环 effort 控制器** | `agent/request` waterfall + `tools/result`/`request-error` 信号反馈 | A + F（生成端） | 直击主因；不只是"按步降档"，而是"默认低挡、出错/循环/首步升档"的控制回路；换挡记 `request/header`（durable） |
| **P2 wire 裁剪适配器（shim provider）** | 注册包装 `LlmAdapter`，对内层 provider 的 `ctx.llm.stream` 前剥离**非必需**轮次的 reasoning 块 | B（回放端） | 确定性剥离 → 缓存前缀仍稳定；DeepSeek 官方本就忽略这些轮 → 语义零变化；但 tool-call 轮协议强制保留（硬下限），收益有上限 |
| **P3 主动回收** | `session/event`(`step/end`) 监听 + 主动调 `ctx.get('toolResultPruner').pruneSession()`；reasoning 占比超阈值时驱动 `ctx.compaction` | E + C（存量端） | 把"撞墙才治理"改成"每步勤打扫"；pruneSession 是现成 public API，零自研 |
| **P4 纯配置调优** | `reasoningEffort`/`thinkingBudgets`/`thresholdRatio`/`retainRatio`/模型 `reasoningEfforts` 声明 | A + D | 立即可用，先跑 baseline |

## 4. 完整解决方案矩阵（已逐条核对可行性）

### P1 闭环 effort 控制器 ★核心插件

- **扩展点**：`agent/request` waterfall（拿到 upstream model-selection 解析后的 `LlmCallConfig`，只降不升）。
- **反馈信号**（全部现成）：
  - `step > 1` → 工具驱动续步，默认压低档
  - `session` 里最近 `tool/result` 的 `isError` → 出错升档（让模型好好想怎么修）
  - 相邻 step 重复同名同参 tool-call（自己从 session 事件算签名）→ 循环升档
  - `ctx.get('tokenMeter').measure(session).totalTokens / requestContext().contextWindow` → 压力降档
- **已实现原型并验证**：类型检查通过、`--patch` 合成进 headless profile、真实 boot + 一次完整任务跑通（见 §6 验证记录）。代码已从仓库撤销，将重写为本地单文件插件。
- **注意**：`agent/request` listener 注册顺序 = waterfall 外层顺序 → boot 期挂载的全局 listener 包在 agent 作用域的 model-selection 外层 → 我们能看到**最终解析结果**再钳制（顺序已验证：`dispatcher.ts` hooks 数组正序包裹）。

### P2 wire 裁剪适配器（shim provider）

- **扩展点**：`ctx.llm.registerAdapter(['<shim-provider>'], adapter)` 注册一个转发适配器；`LlmAdapter` 只有 `stream()` 是必须方法，其余（`resolveModel`/`prepareCall`/`listModels`/`providerRetryPolicy`）都有默认实现可委托给 `ctx.llm.resolveModelInfo(innerProvider, model)`。
- **机制**：`stream(options)` 里构造新 options（`provider: 内层路由` + 剥离后的 `messages`），调 `ctx.llm.stream()` 走内层适配器。新 options 非 loop-built → invariant 的 `isAgentLoopRequest` 检查自动跳过 → **合法且不碰冻结对象**。
- **剥离规则（保守档）**：仅删**不含 tool-call 的 assistant 消息**的 reasoning 块 —— DeepSeek 官方对这些轮本就忽略，语义零变化，前缀仍确定性（不破坏 cache）。
- **激进档（需实测）**：删掉**已完结** tool-call 轮的 reasoning。关键未知量：DeepSeek 对历史 tool-call 消息缺 `reasoning_content` 是 400 还是降级 —— 官方文档说"required"，但序列化注释显示 400 只发生在 content+tool_calls 全空时。**这是 P2 的旗舰实验，决定收益上限**。
- **诚实评估**：agent 循环里大部分 assistant 消息都带 tool-call → 保守档收益有限；激进档若实测可行收益巨大。需要真 API 探测（可用 `my-gateway` 或直连 `deepseek` 路由各试一次）。

### P3 主动回收（reclamation）

- **`ctx.compaction` 公开三件套**（已核对 `CompactionEngine` 抽象类）：
  - `compactIfNeeded(agent, trigger, signal)` — 阈值门控，插件不可用作"勤打扫"
  - `compactNow(agent, signal, commandId?)` — 低于阈值也能压，但要求 agent idle（`runMaintenance`），只能用在 turn 间
  - **`compactRegion(start, end, agent, signal)`** — 强制压缩任意 surface 区间，边缘必须 tool-call/result 配对平衡（`toolPairingBalancedBefore/After` 辅助函数公开导出）→ **reasoning-aware 微压缩的合法原语**
- **模型免费的零成本回收**：直接 `session.append('user/message', {凝缩内容}, {surfaceOp: {op:'replace', ...}, sourceEventSeqs})` + 前置 `compaction/prune` 影子计价事件 —— 确定性凝缩（保 tool-call 名+text、丢 reasoning 全文），一次 LLM 调用都不花。tool-result 部分更简单：`ctx.get('toolResultPruner').pruneSession(session)` 是 public，每个 `step/end` 后主动调。
- **注意**：`user/message` 替换进来的凝缩块角色变成 user —— 与官方 compaction 摘要落盘方式一致（compaction/summary 事件记录 + user/message 承载摘要），语义可接受但要在 README 里写清取舍。

### P4 配置调优（baseline，零代码）

```yaml
# ~/.dsh/profiles/headless/cordis.patch.yml（或 settings.yaml）
agent-default-model:
  provider: my-gateway
  model: deepseek-v4.1-flash
  reasoningEffort: high        # 你的路由需要先声明能力：
llm-pi-ai:
  providers:
    my-gateway:
      models:
        - id: deepseek-v4.1-flash
          reasoningEfforts: { low: "low", high: "high", max: "max" }  # 开启 effort 控制面
compaction-basic:
  modelPolicies: { "my-gateway/deepseek-v4.1-flash": { thresholdRatio: 0.6, retainRatio: 0.2 } }
```

**关键前置（已代码级确认，非推断）**：`my-gateway` 不在 pi-ai 内置 catalog（`catalogModels()` 对未收录路由返回空，`catalog.ts:200`）→ 模型条目又无 `reasoningEfforts` → `model.reasoning=false`（`catalog.ts:702`）→ `reasoning` 元数据不产出（`adapter.ts:191`）。

**更重要的推论（pi-ai anthropic-messages 源码确认）**：pi-ai 的 `streamSimple` 里 `options.reasoning` 为空 → `thinkingEnabled: false` —— **你的路由当前思考是被显式关掉的**（session 实测零 reasoning block 与此吻合）。即：用户反馈的"雷霆思考"问题在你当前配置上**根本没被复现** —— 要复现并验证修复，必须先在模型条目声明 `reasoningEfforts`。

anthropic-messages 协议下 effort 有两条路：`compat.forceAdaptiveThinking=true` 时发 `effort` 级别参数；否则发 `thinking.budget_tokens`（由 `thinkingBudgets` 配置喂值）。你的网关走哪条、是否真正翻译这些参数 → 只能实测（开放问题 2）。

## 5. 推荐的作品集叙事结构

1. **根因**：不是"模型爱思考"，而是 **开环无差别 effort + 全量 CoT 回放 + 阈值门控治理** 三者叠加，外加无思考预算、固定前缀税两个背景项。
2. **约束证明**：为什么不能"发请求时裁掉旧思考" —— frozen request + log-reconstruction invariant + `assistant/message` 禁 `sourceEventSeqs`。证明读过源码、理解 "model-visible ⟺ logged" 不变量。
3. **方案**：三层插件 —— P1 闭环 effort（生成端）+ P3 主动回收（存量端）+ P2 wire 裁剪（回放端，含旗舰实验）。每个扩展点给出官方 API 依据，不改一行官方代码。
4. **验证**：同一任务官方默认 vs 插件开启，比 `inputTokens`/`reasoningTokens`/`request/header` 的 effort、压缩次数。会话日志（zstd jsonl）自带 usage 可量化。

## 6. 验证记录

- `2026-09-14`：`effort-governor` 原型（仓库内临时验证）—— `tsc -b` 通过、`--patch` 合成成功、headless profile 真实 boot + "say hi" 任务完整跑通。随后**已从仓库撤销**（代码迁至本地目录重写）。
- 实测数据：my-gateway/deepseek-v4.1-flash，contextWindow=262144，首请求 inputTokens=12470（纯前缀税），该次无 reasoning。

## 6.5 终轮全链路扫描的新确认事实

逐包读完后的增量确认（全部有代码行级证据）：

### 回放端 —— anthropic 协议侧的精确行为（pi-ai `anthropic-messages.js` 实测源码）

- **带签名** thinking 块 → wire `type:"thinking"` + signature（原文全发）
- **无签名** thinking 块 → 降级为 `type:"text"`（**原文照样全发**，只是换了块类型；`allowEmptySignature` 除外）
- redacted → `redacted_thinking` 数据块回放
- **结论**：anthropic 路径上回放成本与 deepseek 路径等价 —— 推理全文永远上线路，协议层不存在"自动省略"

### P2 shim 在 pi-ai 路径上的签名陷阱（新发现）

`llm/src/index.ts:971-984` `forAdapter()`：dispatch 前把 `source.provider` 属于**别的适配器**的消息的 `replayState` 剥掉 → `toPiAssistant` 块数对不上或 provider 不匹配 → `replayedAssistant` 抛 `INVALID_REPLAY_STATE` → 整条消息降级 `foreignAssistant`（**所有块丢签名**）。shim 转发时必须把 `source.provider` 改写成内层路由名，否则签名全灭。

### 协议硬约束（P2 激进档的真实边界）

- **deepseek 路径**：带 tool_calls 的历史 assistant 消息要求 `reasoning_content`（官方文档）；纯文本 assistant 消息的 reasoning_content 服务端忽略
- **anthropic 路径**：带 tool_use 的 assistant 消息若开启 thinking，须以签名 thinking/redacted_thinking 块开头 → 剥它大概率协议违规
- **双边一致结论：保守档 = 只剥"无 tool-call 的纯文本 assistant 消息"的 reasoning**；激进档（tool-call 轮也剥）只能实测验证

### 计量盲区（新发现）

`llm-pi-ai/src/stream.ts:24-32` `mapUsage` 只映射 input/output/totalTokens/cache —— **pi-ai 的 `usage.reasoning`（thinking_tokens）被丢弃**，你的路由上 `reasoningTokens` 字段永远缺省，reasoning 折叠进 outputTokens 无法单独计量。→ A/B 对比时 reasoning 量只能用「输出 token 差」或日志里 reasoning 块长度近似。

### compaction 调用的真实成本与约束

- 摘要调用 = 一次 `ctx.llm.stream`，刻意复用会话前缀（同 system prompt + tools + 消息序列，只追加压缩指令）→ provider 端是 cache-read 为主，**压缩本身不贵**
- `compactRegion` 要求**turn 打开中**（owner='current-turn'）+ whole-surface 稳定性 → 只能在 `agent/pre-step`/`session/event` 窗口内调
- `compactNow` 要求 idle agent（`runMaintenance`），只能 turn 间用
- 摘要落盘 = `compaction/summary`（log-only）+ `user/message`（surface replace，source=`compactCheckpointSource`）

### effort 的持久化语义（P1 必须处理的细节）

`agent.ts:513-518` + `requestProposal`：adapter 物化的 `defaultEffort`（`adapterDefaults.reasoningEffort=true`）每步从 proposal 剥掉重新物化；而**显式设置的 effort 会持久化到下一步的 seedConfig**。→ 插件第 1 步钳到 low 后，第 2 步 waterfall 看到的就是 low 而非用户原选 —— 升档信号要对比的是**用户意图档位**（首个 `adapterDefaults` 或 AgentOptions），插件需自己记忆 turn 内的"意图档位"而非把 upstream 值当意图。

### 每步重新组装但去重

`preStep` 每步 `systemPrompt.assemble()`（全部 section 重算）+ `SystemPromptProjection.project()` 按文本差异决定去重 —— prompt 不变则无新事件；`time-context` 类插件每步主动注入 `user/message` 是**有意的每步增长源**（opt-in）。

### 官方 deepseek-official 路由对照（截图用户真实环境）

`llm-deepseek`：`thinking: enabled/disabled` 部署开关 + `reasoningEffort: off/low/high/max`（默认 high）+ `defaultContextWindow: 1_000_000`（DEFAULT_CONTEXT_WINDOW，adapter.ts:147 —— **1M 是对的**，只对官方路由；你的 my-gateway 路由吃 pi-ai 的 256K 默认）。该路由 effort 控制面原生齐全 —— P1 在官方路由上零前置配置即可生效。

## 7. 验证状态清单（诚实盘点）

### 已代码级确认 ✅（终轮扫描后完整清单）

**生成端**：agent-loop 全文件（turn/step/preStep/request waterfall/buildRequest/executeToolCalls/assistant-stream）· effort 解析链（`resolveCallWithInfo` 硬拒绝语义 · `requestProposal` adapterDefaults 剥离 · persisted header 恢复）· 官方 deepseek 路由 effort 配置面齐全（thinking 开关 + 默认 high + 1M 窗口）

**回放端**：deepseek `serializeAssistant` 全量 reasoning_content · pi-ai `toPiAssistant`/`replayedAssistant` 签名回放 + 降级路径 · anthropic wire 序列化（带签名→thinking / 无签名→text 全发 / redacted）· `forAdapter` 跨适配器剥 replayState

**计量端**：token-meter measure/fold 全链路（reasoning 计入 surfaceTokens · 锚定 provider usage · step/start-step/end 配对校验）· pi-ai mapUsage 丢 reasoningTokens

**存量端**：compaction 服务三方法 · compactSurfaceRegion 事务全程（start→summarize→stability check→summary+replace→end）· selectCompactableRange 尾部保留 + tool-pairing 平衡 · compactIfNeeded 两触发点 · tool-result-pruner 阈值门控 · spill-policy（大结果落盘，非默认）

**约束端**：frozen request + desync invariant · `assistant/message` 禁 sourceEventSeqs（类型级 `never`）· system-prompt 每步重组去重 · session-checkpoint-policy flush 时机 · `my-gateway` 无 reasoning 元数据 + thinking 显式关闭 + 262K=pi-ai 默认

**信号端**：`agent/pre-step`(waterfall, enter/reject/startsRequestSeries) · `agent/request-error`(waterfall, retry 决定权) · `tools/post-execute`(additionalContexts) · `session/event` · `agent/turn-stopping` · repeat-tool-reminder 实现机制 · time-context 每步注入

### 只能实测、代码看不出 ⚠️

1. 历史 tool-call 消息剥掉 `reasoning_content` 后，DeepSeek/网关 400 还是降级？→ 决定 P2 激进档上限
2. `my-gateway` 网关（your-gateway.example）是否翻译 thinking/effort/budget_tokens？→ 决定 P1/P4 在你路由上是否生效
3. `reasoning_content` 是否计入 context window / 计费？→ 服务端行为，文档说法与实测可能不一致
4. 剥离非必需 reasoning 对 KV-cache 命中率的影响 → 理论上前缀稳定，需实测

### 已闭合的原开放问题 ✅（本轮补查结果）

- `contextWindow=262144` 来源：**pi-ai 的 `DEFAULT_CONTEXT_WINDOW`**（`llm-pi-ai/src/config.ts:64`）—— 模型条目没配 `contextWindow` 且 catalog 无此模型 → 用 provider 默认 256K。
- pi-ai profile 可用字段（`config.ts:322-345` 已核对）：provider 级 `reasoning`（默认思考档位）、`thinkingBudgets`（`{minimal,low,medium,high}` → Anthropic `thinking.budget_tokens`）、`defaultContextWindow`/`defaultMaxTokens`、模型级 `reasoningEfforts`（dict 档位→wire 值，或 `false` 禁用）、模型级 `compat.forceAdaptiveThinking`。
- `resolveCallWithInfo` 拒绝语义（`llm/src/index.ts:882-899`）：模型无 reasoning 元数据时设 effort → `UNSUPPORTED_REASONING_EFFORT` 抛错（非降级）→ 插件必须先查 `reasoning` 存在再写 effort。
- anthropic-messages 思考路径（pi-ai `streamSimple` 源码）：无 `reasoning` 选项 → 显式 `thinkingEnabled: false`；有 → `forceAdaptiveThinking` 走 `effort` 参数，否则走 `thinking.budget_tokens`（`thinkingBudgets` + maxTokens 联动调整）。

## 8. 本地插件目录约定（不进官方仓库）

```
F:\DSH思考问题\
  plugins\<name>.ts          # 零外部 import 的单文件函数插件（见下）
  <name>.patch.yml          # - insert: { id, name: './plugins/<name>.ts', config }
```

运行（仓库根目录，源码直跑经 tsx）：

```sh
cd F:\deepseek-harness
node --import tsx/esm apps/cli/src/bin.ts --profile headless \
  --patch F:\DSH思考问题\<name>.patch.yml "任务描述"
```

插件文件不 import 任何 `@deepseek-ai/*` 包也能跑：`ctx.on/ctx.get/ctx.logger` 全在注入对象上；`ReasoningEffortId` 只是字符串品牌（直接写字面量）；`Config` schema 可省（config 透传）或手写校验。

## 9. 外部研究证据（方案选型依据）

### 学术工作（均为"按步动态分配思考"方向，共识一致）

| 工作 | 方法 | 结果 | 对我们的意义 |
|---|---|---|---|
| ARES（UCSB, arXiv 2603.07915） | 轻量 router 逐步预测"够用的最低档"（low/mid/high） | 推理 token **-52.7%**，成功率不降 | 证明"按步选档"可行；固定低档反而掉 ~20% 成功率 → 机械步不能无脑全压 |
| TAB | 按轮难度分配思考预算 | -35% | "难步多给、易步少给"的分档策略 |
| SelfBudgeter | 模型自估预算 | 长度 -61% | 预算概念（D 项）有依据 |
| Learning When to Think | 每步先选 NoThink/Short/Long | -41% | "看结果步可不想"有据 |

结论：**方向被验证过，本 harness 内无人实现**（全仓库 39 个 effort 相关文件，无一动态调整）。

### 供应商文档事实（DeepSeek 官方 + Anthropic 官方 + 社区实测）

1. **DeepSeek 服务端自动拉满**：官方文档原文 "for some complex agent requests (such as Claude Code, OpenCode), effort is automatically set to **max**" → 用户选 high 也可能被服务端升档，"雷霆大思考"最大嫌疑。**我们发的 effort 是否生效必须实测**。
2. **DeepSeek 回放真实合同**（修正前文 B 项表述）：
   - 请求**不带 tools** 时：历史 `reasoning_content` 服务端忽略且**不计 token**（社区实测：发/不发/发超长哨兵，prompt_tokens 都是 40）→ 纯聊天场景零成本，不用治
   - 请求**带 tools**（agent 场景）时：文档要求调过工具轮的思维链必须带回否则 400；但社区"受控省略"实测有返回 200 → 官方合同严于实际执行，激进裁剪空间存在但须实测
3. **Anthropic 铁律**：含 tool_use 的 assistant 消息的 thinking 块必须原样带回（签名校验，改过 400）；4.6+ 模型历史 thinking 块保留且**按输入计费**。另：文档要求**同一工具循环内不改 thinking 配置** → anthropic 路径上每步换挡有协议风险（deepseek 路径无此限制）。
4. **DeepSeek 有效档位实为 3 档**：官方只有 high/max 真实有效，low/medium 映射到 high，xhigh→max → 机械步真省钱要靠 `off`（关思考），不是 low。
5. 第三方 agent 框架已踩过同款坑（alibaba/open-code-review #811）：thinking 块重建丢签名 → 明文泄漏 + 回放降级。我们的 shim 剥块时必须整体剥，不能半剥。

## 10. 方案终稿（已与用户确认的四项决策）

| 决策点 | 拍板 |
|---|---|
| 换挡打法 | **规则换挡**（穷人版 ARES：信号驱动、零额外调用；不做小模型路由器） |
| 机械步降档力度 | **按步型分两档**：看结果/机械步 → `off`；需规划步 → `high`；出错/绕圈 → 意图档（max） |
| 回放裁剪力度 | **激进剥**（含 tool-call 轮）—— 但必须先做真实 API 探测确认不 400，探测不过则自动回落保守档 |
| 用户显式选 max | **尊重**：显式选择不干预，只治理默认/未选场景 |

### 插件分解（F:\DSH思考问题\plugins\，patch 挂载，官方零改动）

- **A · effort-governor**：`agent/request` waterfall 卡位。turn 内记忆"用户意图档"；按步型查表降档；升档信号 = 工具报错 / repeat-tool 循环 / 首步规划 / 上下文宽裕；降档信号 = 连续机械步 / 压力比高。写 `request/header` 前需查 `model.reasoning` 存在。
- **B · cot-replay-trimmer**：shim adapter 包裹内层 adapter，stream 前改写 wire options.messages 剥历史 reasoning。保守档=只剥无 tool_calls 的；激进档=全剥（默认关，探测实验验证后开）。**必须改写 `source.provider` 为内层路由名**保签名。
- **C · pressure-keeper**：`step/end` 后调 `toolResultPruner.pruneSession()`（免费）+ reasoning 占比超阈值时 `ctx.compaction.compactRegion()` 做 model-free 微压缩。尊重 `status().running` 锁。

### 实施顺序（每步独立验证、可单独停用）

```
0. 配置前置：my-gateway 模型条目加 reasoningEfforts（打开控制面）
1. 探测实验（先于一切插件）：
   a. 网关认不认 thinking/effort 参数？（发带 effort 的 agent 请求，看 reasoning 块是否出现）
   b. DeepSeek 自动 max 是否覆盖我们发的档位？（usage 对比）
   c. tool-call 轮剥 reasoning → 400 还是 200？（决定 B 的激进档可否用）
   d. anthropic 工具循环中途换 effort → 生效还是报错？
2. baseline：同一任务跑默认配置，记 token/步数/压缩次数
3. 插件 A（换挡器）→ A/B
4. 插件 C（勤打扫）→ A/B
5. 插件 B（裁剪，先保守档）→ A/B；激进档视 1c 结果
6. 消融实验：单开/组合开，记录 质量×成本 双指标
```

## 11. 网关实测结论（2026-09-15，your-gateway.example）

探测方法：直接 curl 两个端点 + 本地日志代理抓 harness 真实 wire。

| 探测项 | 端点 | 结果 |
|---|---|---|
| `thinking:{type:disabled}` | anthropic | 忽略，照样返回 thinking 块 |
| `thinking:{type:enabled,budget_tokens:1}`（非法值） | anthropic | 不校验直接接受 → 参数被丢 |
| `thinking:{type:bogus}` | anthropic | 同上 |
| `thinking:{type:adaptive}`+`output_config.effort` | anthropic | low/max 无可区分效果 |
| 顶层 `reasoning_effort` | anthropic | 不转发 |
| 历史 thinking 块（4000字符） | anthropic | input_tokens 不变 → **剥掉不进上游不计费** |
| `reasoning_effort: low/med/high/xhigh/max` | openai | **生效**（低≈120、高≈250、max≈400，介质难度题） |
| `reasoning_effort: off` | openai | 400："valid levels: low, medium, high" → **上游无法关思考，地板是 low** |
| `reasoning:{effort}`（openrouter 格式） | openai | 生效（low=89） |
| `thinking:{type:disabled}` | openai | 忽略 |
| 历史 `reasoning` 字段（4000字符） | openai | prompt_tokens 不变 → 剥掉不进上游 |
| 工具调用 | openai | 正常（finish_reason=tool_calls） |

网关形态：OpenRouter 式转发（`is_byok`/`cost_details`/`provider:"DeepSeek"`），上游真 DeepSeek。

**对本项目的含义**：
- effort 控制面只有走 `openai-completions` 方言才通 → 已加并行 provider `my-gateway-oai`（thinkingFormat 缺省走 generic 分支发扁平 `reasoning_effort`；`compat.supportsReasoningEffort: true`）
- **回放裁剪（原方案 B）在本网关下无意义** —— 网关本来就不把思维链发给上游。该插件只对"会原样转发思维链"的路由（官方 deepseek 直连 / Anthropic 原生）有价值
- 本路由上的真实问题剩：① 每步默认 high 档烧输出 token（插件 A 治）② 本地 token-meter 把不进上游的 reasoning 块照样计价 → 本地压力虚高可能提前触发压缩（插件 C + 计量口径问题）
- 截图用户的官方直连路由（1M 窗口 + effort 档位 + 回放真计费）上三插件价值完整；本机只能验证机制正确性

## 12. 插件实现状态

- `plugins/metrics-logger.ts` —— session/event 蒸馏 JSONL（`runs/*.jsonl`），A/B 数据源
- `plugins/effort-governor.ts` —— `agent/request` waterfall 逐步换挡。**两个已修实现坑**：① `installModelSelection` 先剥继承 effort → 插件要主动写入而非修改；② 写入值会持久化进 request/header → 用 `lastWritten` 防把自己的写值误读成用户显式选择
- `plugins/pressure-keeper.ts` —— step/end 后调公开 `toolResultPruner.pruneSession`（默认阈值 8192 字符，小任务不触发属正常）
- patch 组合：`exp-oai-route.patch.yml`（路由切换，settings 里 agent-default-model 已改）+ `metrics.patch.yml` + `effort-governor.patch.yml` + `pressure-keeper.patch.yml`

**实测 A/B（同形态小任务）**：换挡生效证据 = step1 header `high/adapterDefaults` → step2+ header `off`（wire 发 low）。任务成功率两档一致；小任务上 flash 思考量本来就小，token 差异不显著 —— 收益主要体现在长任务多步累积。

## 13. 消融实验（2026-09-15，同任务：8 文件数词汇总，deepseek-v4.1-flash @ my-gateway-oai）

| 配置 | 步数 | 工具调用 | 输入 | 输出 | 思考字符 | effort 轨迹 | maxTokens | 正确 |
|---|---|---|---|---|---|---|---|---|
| baseline | 4 | 10 | 6,345 | 1,277 | 475 | [high] | — | ✅ |
| governor | 3 | 9 | 1,217 | 738 | 458 | [high,off] | [–,8192] | ✅ |
| keeper | 5 | 12 | 1,614 | 1,382 | 879 | [high] | — | ✅ |
| governor+keeper | 3 | 10 | 1,411 | 1,327 | 681 | [high,off] | [–,8192] | ✅ |

**判读（诚实版）**：
- 机制全部按设计触发：换挡 [high→off]、硬顶 8192 上 wire、keeper 空转（结果未达 8K 阈值）
- baseline 输入高是因为多跑了一轮工具往返（4 步 vs 3 步）—— 主要差异来自往返次数而非插件，不能直接记成插件收益
- 思考字符差异在小任务+flash 上属于噪音区间（458~879），此模型/网关的低档地板本来就浅
- ** keeper 单开那轮暴露一个真实产品 bug**：`glob` 对含非 ASCII 段（`思考问题`）的路径返回空 → 模型被迫 fallback `Get-ChildItem`，多耗一轮。已记入官方系统问题清单
- 量化收益结论：本网关路由上三个插件的**机制**全部验证通过，**量级**受限于该网关的思考地板（low≈100 token）—— 大收益场景是官方直连路由（max 档思考可达 50K+/步）

## 14. 升档逃生实测

任务：先读不存在文件再 fallback。轨迹 `step1:high → 工具报错 → step2:high（升回意图档）→ 修好 → step3:off`。三条逃生通道（tool-error / repeat-loop / cap-truncated）中第一条已实测生效。

## 15. governor v2：输出硬顶（mechanicalMaxTokens）

`agent/request` waterfall 返回的 `LlmCallConfig.maxTokens` 直达 wire `max_tokens`，且 OpenAI 协议下思考 token 计入 completion → 这是**服务端强制的思考保险丝**，比 effort 降档（建议性）硬一级。截断检测：assistant/message `stopReason==='length'` → 下一步自动解封顶+升档。

## 16. 测试过程中发现的官方仓库 bug（只记录，不修官方代码）

- **glob 不认非 ASCII 路径段**：`F:\DSH思考问题\sandbox` 下 `glob "*.txt"` 返回空，`Get-ChildItem` 同路径正常列出 8 个文件。复现于 keeper 消融轮。建议官方侧排查 glob 的路径归一化/编码处理。

## 17. 插件 D：batch-prompter（减少工具往返 = 省整份前缀）

**动机**：消融数据揭示的最大隐藏杠杆 —— 每多一轮工具往返就要为 ~12K 前缀+全量历史再付一次钱。baseline 4 步 vs 插件组 3 步，输入差 5K。

**实现**（`plugins/batch-prompter.ts` + `batch-prompter.patch.yml`）：
- `agent/created` 建立 session→agent 映射
- `session/event` 监听 assistant/message：连续 N 步（默认 2）每步恰好 1 个只读工具调用 → 判为串行扫描
- 触发后 `agent.inject()` 注入一条 plugin-source 持久提示（~30 token，一次性成本），要求模型批量发起独立的只读调用
- 每会话最多注入一次（`rearmAfter` 可配重触发窗口）

**实测**：hint 注入 ✓ → 模型把 9 个调用压进 3 步 → 输入 965（全组最低）。

## 18. 最终消融表（同任务：8 文件数词汇总）

| 配置 | 步数 | 工具调用 | 输入 | 输出 | 思考字符 | 机制证据 |
|---|---|---|---|---|---|---|
| baseline | 4 | 10 | 6,345 | 1,277 | 475 | — |
| governor | 3 | 9 | 1,217 | 738 | 458 | high→off, cap 8192 |
| keeper | 5 | 12 | 1,614 | 1,382 | 879 | 空转（结果<8K） |
| gov+keeper | 3 | 10 | 1,411 | 1,327 | 681 | high→off, cap |
| batch-prompter | 3 | 9 | **965** | 747 | 462 | hint 注入 |
| **全家桶** | **3** | **9** | **1,236** | **724** | **298** | 全部生效 |

所有运行答案均正确（43 词）。**判读**：本路由思考地板浅（low≈100tok），token 节省的大头来自"少一轮往返"而非"少思考"；在官方直连路由（max 档 + 回放计费）上三个插件的收益会大一个数量级。

## 19. 插件套件总览（全部独立，官方仓库零改动）

| 插件 | 治什么 | 机制 | 状态 |
|---|---|---|---|
| metrics-logger | 测量基建 | session/event → JSONL | ✅ |
| effort-governor | P1 恒定档 + 无预算 | 逐步换挡 + maxTokens 硬顶 + 三传感器升档 | ✅ 全验证 |
| pressure-keeper | P6 撞墙才打扫 | step/end 后调官方 pruneSession | ✅ 挂载 |
| batch-prompter | 12K/轮 前缀税 | 串行扫描检测 + 一次性 inject 提示 | ✅ 注入生效 |
| cot-replay-trimmer | P4 回放 | （本路由无收益，留待官方路由） | 挂起 |

## 20. 本轮实测修正与加固（2026-09-15 下午）

**keeper 修复（真 bug）**：`session/event` 监听器在 append 发布临界区内同步触发，里面调 `pruneSession`（要 append 新事件）触发 `session append cannot reenter`。改挂 `agent/pre-step` —— 构建下一步请求前清理，时机更准。修复后实测：24,537 字符的 read 结果 → `compaction/prune` 落地（shadow-price 6013 tok）→ 替换为 5,382 字符。

**governor 加固（两个真 bug）**：
- 摘帽用显式 `maxTokens: undefined` 会被 request/header 序列化检查拒绝并杀死 turn → 改解构去 key。
- 截断检测重写：持久化 message 上**没有** stopReason 字段（finish chunk 不落盘），且 `agent.ts:484` 截断直接终结 turn —— 无"下一步"可逃。正确做法 = `turn/end` 事件（`reason.kind==='max-tokens'` 持久化）+ 断路器：封顶 turn 死于截断满 `maxCapTruncations`（默认 2）次 → 本会话永久摘帽。

**前缀税修正**：usage 里 `cacheReadTokens` 每轮 12-14K —— DeepSeek 前缀缓存生效，12K 前缀按命中价（~1/4）计费而非全价。batch-prompter 的"省一轮=省12K"修正为"省一轮=省~12K缓存读+少量未缓存"。杠杆依然成立但量级下调。

**glob 非 ASCII bug 已记录**（§16），官方仓库未动。

## 21. 深度核查结果（每条结论的证据状态）

### 代码级已验证（原始 session 或代码行号可复核）

| 结论 | 证据 |
|---|---|
| 相同请求配置不落盘，`headerEquals` 去重，变化才记 `reason:'change'` | agent.ts:573 + 原始 session 实测（连续同配置步无 header） |
| `requestProposal` 只剥 `adapterDefaults` 标记字段 → 插件写入的 maxTokens/effort 会持久化进下一步 proposal | agent.ts:63-68 + 原始 session（change header 携带我们写的值） |
| `adapterDefaults:{reasoningEffort:true}` 标记适配器默认档，供区分"用户显式 vs 默认" | 原始 session initial header |
| `request/context` 携带 `contextWindow` | agent.ts:584-597 |
| `measure().totalTokens` 是压力字段 | token-meter/types.ts:30 |
| `tool/call` 事件载荷 `{callId,name,arguments}`；`tool/result` 的 `content[0].isError` | session/types.ts:341, llm/types.ts:101-105 |
| `session/event` 内不可 append（重入抛错） | 实测错误 + keeper 改挂 pre-step 后 prune 真落地 |
| `compaction/prune` + 替换 `tool/result` 真实生效 | 原始 session：24,537→5,382 字符，shadow-price 6013 tok |
| `turn/end` 携带 `reason.kind`（含 'max-tokens'），message 上**无** stopReason | 原始 session + agent.ts:484（截断直接终结 turn） |
| `agent.inject`/`steer`/`pre-step`/`turn-stopping`/`agent/created` 签名 | runtime-types.ts:215-241,330,373,391 |
| 显式 `maxTokens: undefined` 过不了 request/header 序列化 | 实测 turn 死于 non-JSON-serializable，改解构去 key 后正常 |
| maxTokens 透传到 wire | adapter.ts:383 + header 事件可见 |

### 网关行为已验证（探测实验）

| 结论 | 证据 |
|---|---|
| anthropic 端点忽略一切思考控制参数 | curl 探测（disabled/enabled/bogus 全返回 thinking） |
| openai 端点 `reasoning_effort` 生效 | low≈120 < high≈250 < max≈400（中难度题） |
| 上游无法完全关思考：`off` → 400 | "valid levels: low, medium, high" |
| 两端点都剥历史思维链再转发 | 4000 字符 reasoning 回放 → prompt_tokens 不变 |
| DeepSeek 前缀缓存生效 | usage.cacheReadTokens 每轮 12-14K |

### 未验证 / 边界声明（诚实标注）

| 声明 | 状态 |
|---|---|
| 降档大幅省思考 token | **本模型/网关验证不了** —— flash 思考地板浅（max 档也难任务仅 ~500-700 字符），机制正确但量级不显著。大收益需官方直连路由或思考量大的模型 |
| batch-prompter 因果归因 | n=1，模型可能自发批量 —— 提示确实注入且那轮批量了，但不能断言因果 |
| max-tokens 断路器 | 代码逻辑简单已审，端到端只在 cap=60 折磨测试中间接验证（turn 死亡→计数） |
| 工具调用轮剥思维链 API 是否接受 | 本网关无意义（反正被剥）；官方路由未测 |
| pi-ai `reasoning_tokens` 计量盲区 | 代码已确认（mapUsage 丢弃），未提官方修复 |

## 22. 子代理独立评审与修复（第三轮核查）

三个只读子代理分别审计：① 压缩/上下文子系统剩余杠杆 ② 每请求固定开销削减面 ③ 四个插件的逐行合约核对。评审共发现 **3 个严重功能缺陷 + 若干行为偏差**，全部已修并标注验证状态。

### 已修复并实测验证

| 缺陷 | 原状 | 修复 | 验证 |
|---|---|---|---|
| **batch-prompter 从不生效** | `session/event` 内调 `agent.inject` → inbox.splice → append → **重入抛错被吞**，hint 从未落盘；此前 "hintInjected" 是误报（检测到 system-prompt 的 plugin 源快照消息） | 改走 `agent/pre-step` 瀑布在 enter 决策上追加消息 | ✅ 实测：`user/message seq=21, plugin=dsh-batch-prompter` 落盘，streak=1 强制触发 |
| **断路器被持久化 cap 反转** | 熔断后 `cap===undefined`，但持久化 header 把旧 cap 带回 proposal，`===` 比较永不成立 → cap 永远摘不掉 | 跟踪 `lastCapWritten`，按"上次实际写入值"剥离 | ✅ 代码级 + 回归跑通（逻辑路径同 escalate 摘帽） |
| **resume 后插件永久关闭** | resume header 把插件自己写的 effort 恢复为"用户显式选择" → `explicit=true` → governor 停摆 | 读 `data.reason`；`reason==='resume'` 只种 intent 不置 explicit | ⚠️ 代码已修，headless 单轮无法实测 resume 路径 |
| **keeper 跳过每 turn 第一步** | `step===1` 恰好是累积结果最多的时刻 | 每步都跑（无候选时官方 prune 本身是空转） | ✅ 代码级 |
| **新 turn 规划步被污染** | turn≥2 step1 的 proposal 携带着上一 turn 我们写的 lowLevel+cap | step1 恢复 intent 档 + 摘我们的 cap | ⚠️ 代码已修，headless 单 turn 无法实测 |
| **用户 maxTokens 丢失** | 覆盖后无法恢复用户原值 | 首次见到非我方写入值时记录 `userMaxTokens`，摘帽时还原 | ✅ 代码级 |
| **toolError 跨 turn 残留** | 上 turn 末尾错误会让下 turn 首步误升档 | `turn/start` 时清零 | ✅ 代码级 |
| **metrics 统计口径** | replace 与 append 型结果行内不可区分（双计风险）；数组不截断 | 行内补 `surfaceOp`/`sourceEventSeqs`/`time`；数组限长 32 | ✅ 代码级 |
| Map 强引用泄漏 | 4 处 `Map` 键为 session/agent 对象从不清理 | 全部改 `WeakMap` | ✅ 代码级 |

### 新插件：read-deduper（第五件，子代理审计发现的真空缺）

**问题【代码已验证】**：同一 `read` 调用（相同路径+参数）重复发出时，所有版本的结果都留在 surface 上，每轮请求重复付费；官方没有任何去重机制。

**方案**：`session/event` 里按 `callId` 关联 call→result，按 `name + 规范化 arguments` 做去重键；`agent/pre-step` 里用官方同款 `compaction/prune` + `surfaceOp.replace` 协议把旧结果就地替换成一句话指针。保守策略：只合并参数完全相同的调用（不同分页窗口不合并）、错误结果不动、`minChars` 以下不动、永远保留最新一份。

**实测证据**（`runs/dedup-test.jsonl`）：同一 `read big.txt` 调两次 → `compaction/prune seq=31 shadowedTokenCount=6013` + `tool/result seq=32 replace seq=24`（22KB 结果 → 一行指针），后续每轮请求省 ~6K token。

**踩到的真坑**：原始 append 事件的 `surfaceOp` 不是 `undefined` 而是 `{op:'append'}` —— 第一版按 `=== undefined` 过滤导致永远追踪不到结果，改为按 `op !== 'replace'` 判断。

### 子代理发现的其它方向（评估结论）

| 方向 | 证据 | 是否采用 |
|---|---|---|
| `compaction-basic` 全量可配置：`thresholdRatio`/`retainRatio`/`summarizationProvider/Model`/`maxTokens`/`modelPolicies` | config.ts + cordis.patch.yml 无 config 行 = 跑纯默认值 | ✅ 采纳为**配置层建议**：摘要可路由到便宜模型、阈值可调；写 patch 即可不需代码 |
| pruner `thresholdChars/headChars/tailChars` 可配置 | config.ts:10-14 | ✅ 配置层建议 |
| `tools.restrict` 给主 agent 瘦身 schema | tools/index.ts:1061-1088，file-reference-local 同款用法 | ⚠️ 可用但属部署选择；工具集必须**保持稳定**，频繁变动→`startsSeries`→前缀缓存整体失效（subagent 证实） |
| `system-prompt/assemble` 瀑布裁剪 sections/tools | system-prompt/index.ts:31 | ⚠️ 同上：工具集变动会让缓存失效还回收益 |
| `includeRuntimeContext: false` 一行关快照 | system-prompt/index.ts:242-263 | ✅ 配置层建议（收益小但零成本） |
| `time-context` 每步注入持久消息 | time-context/index.ts:180-220 | ✅ 若启用则调 `refreshIntervalMs`；base bundle 不含 |
| `tools.mode: 'ptc'` 折叠全部 schema 到 run_code | tools/index.ts:644-667 | ⚠️ 大行为变化，部署决策非插件 |
| `systemPromptUpdate:'in-history'` 保前缀缓存 | runtime-context.ts:81-96；目录里仅 deepseek-flash 带 | ⚠️ 需改 catalog 配置，且 prompt 中途变更才生效 |
| 压缩摘要换便宜模型 `summarizationProvider/Model` | compaction-basic config | ✅ 配置层建议 |
| `llm/stream` 不可改 loop 请求（冻结） | llm/index.ts:64-72 | 已排除：不是有效介入点 |
| `internal/dispatch` 内部事件 | cordis events.ts | 已排除：非公开扩展点 |

### 评审后仍标注"未实测"的项（诚实声明）

- **resume 路径修复**：逻辑已对（reason 区分），但 headless 一次性任务跑不出 resume；需 web profile 或多轮会话实测
- **断路器多轮语义**：截断即终结 turn，断路器跨 turn 累计，headless 单 turn 只能验证"计数+摘帽逻辑正确"
- **turn≥2 step1 恢复逻辑**：同上，需多轮会话
- **read-deduper 对非 read 工具**：`tools` 配置支持扩展，只实测过 read

### 回答"还有没有其他方向"

子代理把压缩、token-meter、request 组装、system-prompt、tools、context 注入全链路扫完了。**除已实现的 5 个插件 + 上述配置层旋钮外，没有第四个"机制级"收益点**——剩余的都是：① 配置调优（不需写代码）② 部署决策（restrict/PTC/关快照）③ 需官方源码改动（如动态裁剪）。插件套件的覆盖面已对齐代码里全部合法介入点。

## 23. 多轮验证 + pro 模型探测 + n=3 基准（第四轮核查）

### 多轮验证 —— 测试驱动插件 `multi-turn-driver.ts`（仅实验用）

headless 是一次性单 turn，但 `agent.followup` 可在 turn 1 运行期间预排后续 turn，让进程活到 turn 2/3 结束。借此把之前"代码级验证"的两项补成实测：

**E3 修复实测（turn≥2 规划步恢复意图档）** —— `runs/multiturn-A.jsonl`：

```
turn1: step1 initial effort=high → step2+ change effort=off+maxTokens=8192 → completed
turn2: step1 change effort=high maxTokens=undefined  ← 恢复意图档+摘掉我们的 cap ✅
       step2 change effort=off+maxTokens=8192        ← 机械步继续治理 ✅
```

**E1 修复实测（断路器摘帽）** —— `runs/breaker-test.jsonl`，cap=60 强制截断：

```
turn1: off+cap60 → turn/end reason=max-tokens（count=1）
turn2: step1 恢复 high → off+cap60 → max-tokens（count=2，熔断触发）
turn3: step2 off 且 maxTokens=undefined  ← 持久化的 cap=60 被 lastCapWritten 匹配剥离
       turn/end reason=completed        ← 旧代码此处会带着 cap 继续死循环 ✅
```

**唯一仍未实测的**：跨进程 resume（headless 每次新建 sessionId，物理上无法产生 resume header；web profile 或真重启才能验）。其余全部有原始 session 证据。

### pro 模型探测 —— 网关能不能复现"思考爆量"

发现网关 anthropic 目录里还有 `deepseek/deepseek-v4-pro-0813`（pro 版）。把它加到 OAI 路由实测（`runs/probe-pro.jsonl`）：

| 档位 | 任务 | reasoning 字符 |
|---|---|---|
| high | 模幂计算 | 3,124 |
| max | 模幂计算 | 2,543 |
| low | 数论推导（难） | 6,951 |
| max | 数论推导（难） | 4,814 |

**结论【实测】**：即使换 pro 模型，这个网关的 `reasoning_effort` 档位对思考量的区分度依然很弱，且非单调（任务难度影响远大于档位）。**该网关层面无法复现截图用户的"max 档一步 100-200K"爆量** —— 那是官方 DeepSeek 直连/特定上游的行为特征。我们插件的"量级收益"只能在那类路由上测量；本网关上能证明的极限就是"机制正确 + 方向一致 + 保护路径真实触发"。

### n=3 基准（同任务：8 文件数词，全部答对 43 词）

| 配置 | run | steps | calls | input | output | cache-read | reasoning chars |
|---|---|---|---|---|---|---|---|
| baseline | 早先 | 4 | 10 | 6,345 | 1,277 | — | 475 |
| baseline | B1 | 4 | 10 | 6,252 | 1,092 | 46,720 | 384 |
| baseline | B2 | 5 | 10 | 1,223 | 1,309 | 65,408 | 812 |
| 全家桶 | 早先 | 3 | — | 1,236 | 724 | — | 298 |
| 全家桶 | S1 | 5 | 12 | 6,970 | 2,254 | 61,952 | 1,504 |
| 全家桶 | S2 | 4 | 10 | 1,471 | 1,102 | 51,584 | 551 |

**诚实解读**：input token 的组内方差（1.2K–7K）远大于组间差异 —— 决定 input 的主因是**模型当轮是否自发批量**，不是插件。这反向证实了早先 batch-prompter 的归因不可断言因果。在本网关上，插件组的确定收益体现在机制证据（effort 轨迹、cap 上 wire、dedup/prune 的 replace 事件、断路器摘帽），而非 token 总量差异 —— 浅思考地板下没有大头可省。

### 目前全部已验证机制清单（更新）

- 换挡（initial→change header）✅ 多 turn 实测
- 硬顶上 wire + 摘帽 ✅
- 报错升档 ✅
- 断路器（截断计数→永久摘帽）✅ 多 turn 实测
- turn≥2 规划步恢复意图档 ✅ 实测
- keeper 真实剪枝（24.5K→5.4K）✅
- deduper 真实 replace（6013 tok shadow-price）✅
- batch-prompter hint 真实落盘 ✅（修复后）
- resume 路径修复 —— ⚠️ 代码级，无单进程外验证手段

## 24. 官方 DeepSeek 直连路由实测（目标场景，wire 级证据）

用户补充了官方 API key，路由切到 `deepseek-official` / `deepseek-v4-pro`（contextWindow=1M，截图同款环境）。通过本地转发代理抓到真实 wire 数据（`runs/official-wire.log`）。

### 官方路由与网关的本质差异【wire 实测】

| 行为 | 网关路由 | 官方直连 |
|---|---|---|
| `effort=off` | 映射到 low（地板档，仍思考） | **`thinking:{type:'disabled'}` —— 真关，生成 0 字符** |
| 历史思维链 | 网关剥掉，不进上游 | **`reasoning_content` 真回放进请求体**（每轮 ~3-9K 字符） |
| adapter 默认 maxTokens | 无 | **256,000**（巨大默认出口） |
| effort 档位区分度 | 平（low≈high≈max） | 真实（off 完全无思考） |

### A/B wire 数据（同类编码任务，都一次通过测试）

**Baseline（全程 max）**：每步 completion 194-1,192 tok；每轮回放 reasoning ~3.7K 字符；cached_tokens 命中正常。

**Governor（step1 max → step2+ off+cap8192）**：
- step2-4 生成 reasoning = **0**（disabled 真生效）
- 第一次切档请求 `cached_tokens=0` —— **thinking 参数变化使前缀缓存整轮失效**（约 12K prompt 按全价计一次），下轮恢复
- step1 的 8,870 字符思考继续逐轮回放（缓存价）

### 关键洞察：用户痛点的真正位置

baseline 的机械步在 max 档本来就只思考 ~100-160 字符 —— **模型自我调节，简单步不怎么想**。"一步烧 100-200K"的大头是 **step1 的规划性思考**，而原设计故意不动 step1。

**因此新增 `planningMaxTokens` 配置**：step1 保持意图档不变，只加输出硬顶当保险丝。实测 `planningMaxTokens: 2000` 上到 step1 的 wire header，思考 3,044 字符未触顶、任务正常完成。对真实爆量场景，设 32K 即可物理截断 200K 失控思考。

### 本环境如实结论

- 机制在官方路由上**全部成立且更强**（off 是真关，不是地板档）
- 当前测试任务规模下，回放税 ~1-2K tok/轮、换挡税一次性 ~12K —— 都是小数字；插件的真正收益期在"长会话+难题+max 档"组合，与截图场景一致
- 官方路由有 `DEEPSEEK_API_KEY` 才能测；已通过 `deepseek-official/deepseek-v4-pro` 验证全链路

## 25. 真爆量复现 + planningMaxTokens 截断熔断全链路（决定性证据）

官方路由 `deepseek-official` / `deepseek-v4-pro` @ max，任务：从零实现回溯法迷你正则引擎（真复杂活）。

### 裸爆量基线（`runs/official-wire.log` 前半 + explode-baseline.jsonl）

```
step1: 单次思考 30,193 字符（completion_tokens 8,919）
step2-5: 该 30K 思维链每轮完整回放进 reasoning_content（30,193→30,352 字符）
prompt_tokens: 12,656 → 24,634（请求体 60KB → 103KB）
```

**用户投诉的形态完整复现**：一次规划思考爆 3 万字符 + 每轮请求永久背 ~9K token 回放税。20 步任务 ≈ 18 万 token 纯回放——和"100-200K"投诉吻合。

### 截断+熔断+恢复 全链路实测（explode-capped.jsonl + wire log 后半）

`planningMaxTokens: 3000` + `maxCapTruncations: 2` + 三连 turn（multi-turn-driver 驱动）：

```
TURN1: step1 header max+maxTokens=3000 → wire 实测 completion 恰好 3000 截断
       → turn/end max-tokens（count=1）
TURN2: 同路径再截断（count=2 → 熔断）
TURN3: step1 header maxTokens=256000（持久化 cap 被剥离，适配器默认恢复）
       → 思考 670 字符 → step2+ off → turn/end completed ✅
```

**三层保护全部真实触发**：物理封顶（3000 截住 ~9K 的爆发）、熔断（两次截断后永久摘帽防死循环）、恢复（摘帽后正常完成）。

### 诚实的代价声明

- 截断的 turn 作废（两次"保险丝跳闸"各烧 3000 tok，总 ~6K 保护成本）
- **被截断的废思维链同样回放**（wire 实测 11,402→22,602 字符累积）——截断挡住"没烧完的"，挡不住"已产生的"回放税。要根治回放税需要 reasoning 历史 shadow（插件 #6 候选，但官方要求 tool-call 轮必须带 reasoning_content 签名，强剥可能触发上游报错，未做）
- `planningMaxTokens` 是把双刃剑：设太小（如 3000）会让正常难题连续跳闸；生产建议 32K 起步

### 至此全部声明的证据状态

| 声明 | 状态 |
|---|---|
| max 档复杂任务单步思考可达 30K+ 字符 | ✅ wire+session 双证 |
| 历史思维链每轮回放进请求体、累计计费 | ✅ wire 实测（reasoning_content + prompt 增长） |
| `off`→`thinking:disabled` 真关思考 | ✅ wire 实测生成 0 |
| `planningMaxTokens` 物理截断爆量 | ✅ 实测截断于 3000 |
| 截断→熔断→摘帽→恢复 全链路 | ✅ 三 turn 实测 |
| 换挡一次性失效前缀缓存 | ✅ wire 实测 cached=0 |
| 前缀缓存覆盖回放成本 | ✅ cached_tokens 占大头（回放按缓存价，非免费） |
| 跨进程 resume | ⚠️ 仍仅代码级（headless 物理限制） |

## 26. reasoning-sweeper v2：回放税根治实测（决定性收尾证据）

### 协议级死路（v1 结论）

`surface.ts` 明文禁止 `assistant/message` 携带 `sourceEventSeqs`（"embeds its source stream"）→ **assistant 节点永远无法被自身类型替换**，"只剥 reasoning 保留 tool_calls"的外科手术在公开协议上不存在。同时 `deriveMessages()` 直取 surface、无插件可拦截消息内容 —— 请求侧也无路。

### 唯一合法路径：整组替换（官方压缩同款）

`validateSurfaceRegion` 只要求"切口两侧无未闭合 tool-call"。因此把 **assistant(reasoning+tool_calls) + 它对应的全部 tool/result** 作为一个平衡组，用一条 `user/message` 摘要整体替换 —— 与官方 region compaction 同一协议（`compaction/prune` 计价 + `user/message` replace + `sourceEventSeqs` 全覆盖）。整组删除后 wire 上不存在"需要签名的 tool-call 轮"→ 绕开了签名要求而非违反它。

### 实测（官方路由 deepseek-v4-pro，同正则引擎任务，wire 代理 + session 双证）

配置 `keepLatest:0, minChars:100`：

```
session 层: 8 个组被替换，最大的两个:
  seq=17 组: assistant(33,852 chars 思考 + 2 工具调用) + 3 tool/result
             → prune(shadow 8,762 tok) → 一条 user/message 摘要
  seq=58 组: 45,927 chars 思考 → 同样整组替换
wire 层:   替换点后所有请求 reasoningChars = 0（回放税归零）
           prompt_tokens 稳定在 ~13K（对照裸跑组同阶段 55K→85K，回放 218K 字符）
           cached_tokens 保持 ~93% 命中（替换近尾端发生，前缀未毁）
上游:      全部 200，无 400/签名报错
结果:      任务正确完成（rt13 全部断言通过）
```

### 定性

| 问题 | 答案（实测） |
|---|---|
| 剥掉历史思维链会被官方 API 拒吗 | **不会** —— 整组替换后无 tool-call 轮需要签名，全 200 |
| 回放税能否根治 | **能** —— wire 实测 reasoning_content 归零，prompt 不再爬坡 |
| 前缀缓存代价 | 极小 —— 替换总发生在近尾端，cached 命中率 ~93% |
| 质量 | 模型把替换消息正确理解为"早期步骤已压缩"，任务完成无误 |

### 残留风险（如实）

- 替换把结构化的 tool_call/result 降级为 user 文本 —— 模型"记得自己调过什么"靠摘要文本，不是真结构化历史。`keepLatest` 建议 ≥1 保最新组。
- 摘要里 result 预览有 `resultPreviewChars` 截断 —— 大结果被二次压缩（可配）。
- 这是**官方压缩的确定性低配版**：官方摘要由 LLM 写、信息保真更好但烧 token；本插件模板化、零成本、立即生效。两者不冲突（sweeper 先清思考，官方压缩处理剩余压力）。
- 跨进程 resume 路径仍未实测。

## 27. 终审：三个独立审计 + 全部修复（收尾轮）

发布前最后一轮，三个子代理独立读真实源码（不依赖既往结论），分别审：sweeper 协议假设、剩余成本通道、全部插件对抗评审。

### 抓到并已修的真缺陷

| 插件 | 缺陷 | 修复 |
|---|---|---|
| reasoning-sweeper | **截断轮（max-tokens）留下未应答 tool-call → `open` 永不归零 → 插件静默永久失效**（一条截断消息让整个 session 再不扫描） | 组归属改为按 callId 匹配；未闭合 span 遇到新 assistant 即放弃，不污染后续组 |
| reasoning-sweeper | 组内出现异类节点（user/system message）会被误当 result 影子化 | 组内含非 tool/result 节点 → 整组拒绝替换 |
| reasoning-sweeper | `tried.add` 在两个 append 之前 → 部分提交留孤儿 prune 计价 + 永久拉黑 | 两个 append 都成功才标记；整个扫描包在 try 里（sweeper 永不能让 turn 失败） |
| reasoning-sweeper | `isError` 读错层级（在 `content[0].isError` 不在 message 层）；未查 `signal.aborted` | 已修 |
| read-deduper | **`Object.keys(args).sort()` 白名单递归生效 → 嵌套参数被剥光 → 不同参数误并** | 递归 key 排序正常化 |
| effort-governor | **resume 后 intent 被持久化的插件低档位污染**（重启后升档路径失效 + 规划步带着 off） | 首个 header 事件时回扫日志找 reason='initial' 的权威 header 恢复真 intent+explicit |
| effort-governor | **lowLevel 不在路由声明的 efforts 列表 → prepareCall 抛 UNSUPPORTED_REASONING_EFFORT，每个机械步都死** | 惰性 resolveModelInfo 校验；不支持的档拒绝写入（保底：不换挡但仍可上 cap） |
| effort-governor | toolError 被同步后续成功结果清掉（并行结果覆盖） | 改 turn 内粘性 OR 累积 |
| batch-prompter | hint 可能落进未闭合 tool-call 组内 | 注入前折叠 surface 平衡，open≠0 跳过 |
| metrics-logger | 每事件同步 appendFileSync 在热路径上 | 缓冲 64 行/turn-end 批量 flush |
| 全部 | （确认）审计过"重试逃逸 cap"——复核为误报：重试走同一决策路径会重新上同 regime | 无需改 |

### 审计确认无误的部分（一并记录）

- sweeper 的 user/message 载体是唯一合法选择；`deriveMessages` 落位正确；持久化 replay 逐事件确定性重放
- 每步扫描产生一条 `request/header reason='series'`（replaceGeneration 变化 → 新 series）——是设计内行为，快照测试本来就过滤它
- 插件间无同 pre-step 竞争：post-next 逆注册序串行执行，后跑者看到前者已落地的替换；deduper/sweeper/keeper 互相不会瞄准同一 seq
- multi-turn-driver 是测试专用（全局 armed/queue 不适合多 agent 并发）——已在文档标注勿发布

### 仍未覆盖的剩余通道（如实记录，多为配置层而非新插件）

- **工具 schema 全量每轮序列化**（~1.5-4K tok/请求，缓存价）：削减需 `tools.restrict`/PTC 组合模式，非插件职责
- **runtime-context / agent-instructions / skill catalog 的 append-only 增长**：各自有节流逻辑，但旧副本永驻直到压缩
- **压缩摘要本身烧思考档**（compaction-basic 用模型写摘要）：可用 `summarizationModel` 换便宜模型，配置层
- **子代理结算通知把子 agent 整个最终输出嵌入父历史**：无界但条件触发

### 最终结论（全部实测/代码级）

六大成本通道均有对应治理且官方路由 wire 级验证通过；本轮审计的 3 个 MAJOR（sweeper 永久失效、deduper 误并、governor resume 污染+档位拒绝）全部修复并通过回归。剩余风险已逐条标注：sweeper 摘要是模板化低配版压缩（信息降级为有界文本）、lowLevel 需路由支持、resume 恢复为日志回扫（首次 header 事件触发）。

## 28. 外部案例对照 + 第 7 个插件 loop-breaker（打转熔断）

### 帖子信息点提取（X @Ion_Mio_，deepseek-v4.1-flash 长思考 4 小时烧 30M token）

- 形态不是"一步爆量"而是**持续打转不收敛**："还在思考和调研"、中断一次后继续
- GitHub issue #17892：v4.1-flash 的 thinking output **无限循环**
- 评论关键句："清洗 session log 会发现 99% 的 thinking 都是原地打转" —— 思考内容**重复性兜圈**
- 官方 `repeat-tool-reminder` 只对**完全相同参数**的连发提醒 —— 近似搜索/调研循环（参数微变）完全漏网

### 对照覆盖面 → 缺口

| 症状 | 覆盖 | 说明 |
|---|---|---|
| 单步爆量 | ✅ planningMaxTokens | |
| 思维链回放税 | ✅ sweeper | 附带疗效：剥掉历史思考也打断了"读自己兜圈思考→继续兜圈"的自强化环 |
| 思考内容重复打转 | ❌→✅ | 新增 reasoning-echo 信号 |
| 同工具不同参数连发 | ❌→✅ | 新增 same-tool streak（官方 reminder 盲区） |
| 只读不产出（调研循环） | ❌→✅ | 新增 no-progress 信号（连续 N 步无 mutating 调用） |

### loop-breaker.ts 设计

三信号任一触发 → pre-step 注入分级指令（advisory，非阻断）：
1. reasoning-echo：连续 assistant 消息的归一化思考签名（头300+尾300+长度桶）重复
2. same-tool：同名工具连发 N 次（不看参数 —— 正是官方 reminder 的盲区）
3. no-progress：连续 N 步无 mutating 工具（write/edit/bash 等）

注入点仍要求 surface 平衡（open=0），有 cooldown 防骚扰，指令强度随触发次数升级（"提交行动"→"停止探索"→"直接作答"）。

### 实测（网关 flash，8 连 read 任务）

```
tool/call: read ×8（无 mutating）
seq=36: user/message plugin=dsh-loop-breaker 指令落地
seq=38: 模型切到 pwsh（mutating）收尾 → 任务正确完成
```

### 诚实的边界

- 检测是启发式：合法的长读链（真要读 10 个文件）也会触发 —— 所以动作是**建议性指令**不是阻断，模型可自行判断
- reasoning-echo 的头尾签名可能误报"每步开头相似"的正常思考 —— 阈值默认 2，可调
- "99% 原地打转"这种深层质量问题无法靠插件根治（模型能力边界）——我们治的是**打转的代价**：让它不无限烧、不背着打转记录继续打转、被打断后能收敛

## 29. 最终架构：单插件 token-guardian【已落地】

### 决策：7 插件 → 1 插件

原设计 7 个独立插件（engineer 视角），用户视角的问题是：装 7 个东西、理解 7 组开关、排查 7 份日志。合并为 **`plugins/token-guardian.ts`**（646 行），一个 `session/event` 折叠器收集全部信号，一个 `agent/request` 做 effort/cap，一个 `agent/pre-step` 串行跑 4 个 mutator（各包独立 try/catch —— 单功能故障不拖死整套）。

### 三层分级 —— 核心产品决策

| 层 | 机制 | 默认 | 伤任务风险 |
|---|---|---|---|
| 纯省 | sweep 思维链回放 / dedupe 重复结果 / prune 大结果 | **开** | 零（只删冗余） |
| 软劝 | loop 三信号 + 预算超限 → 注入"收敛"指令；batch 提示 | **开** | 近零（建议非截断，模型可不听） |
| 硬砍 | planningMaxTokens / mechanicalMaxTokens / routine off | **关** | 有（截断作废该轮） |

关键修正：此前把 `planningMaxTokens` 等硬上限当默认配置是错的 —— 截断一个还在产出的思考 = 作废该轮。硬上限改为**纯 opt-in**，只有明确怕失控的用户才开；且有熔断兜底（连截 N 次自动摘帽，实测验证）。

### 用户面

```yaml
plugins:
  yuqi-token-guardian:
    plugin: .../token-guardian.ts
    config: {}   # 装上就完事；想调哪层改哪层
```

`suite.patch.yml` 现在只有一行。被取代的 6 个单功能文件及其独立 patch 已删除；保留 `metrics-logger.ts`（观测，opt-in）和 `multi-turn-driver.ts`（测试专用）。

### 合并后回归【已验证】

网关路由实测：任务正确完成、零告警零报错。各机制逻辑与单插件版逐一对应（含全部审计修复：callId 匹配组归属、offered-efforts 校验、intent 恢复、嵌套参数排序、平衡边界注入）。

### 对用户批评的直接回应

- "一次搞这么多插件" → 现在是一个
- "预算到了截断也不好" → 默认不截断任何东西，超限只注入文字建议
- "本质上还是要做事情" → 默认层全是"省"不是"砍"，任务该想多少想多少，只是不再背着旧思考反复付回放税

## 30. 合并版官方路由实测【已验证】+ 两个修正

### 实测（deepseek-official/deepseek-v4-pro，wire 代理）

第一场意外拿到**对照组**：`suite.patch.yml` 最初写成 `kind: add` 格式（非合法 `PatchOptions`，只认 `- id:` / `- insert:`）→ guardian 静默未加载，跑出纯裸跑数据：step1 思考 **44,411 completion tokens**，step2 起每轮 wire 携带 **144,937 字符** reasoning_content 回放，请求体涨到 211KB。

修正 patch 格式后重跑，guardian 默认配置（`config: {}`）：

- req6-9 全部 `thinking:disabled`（机械步降档生效）
- **所有后续请求 reasoning_content = 0**（大规划组被摘要替换）
- 请求体稳定 ~78KB（对照组 211KB）
- 全部请求上游 200

### 两个教训

1. **patch 格式必须是 `insert`/`id` 形态** —— 非法格式不报错、静默跳过，是最危险的失败模式。suite.patch.yml 已修正。
2. **`keepLatest` 默认必须 0**：`keepLatest:1` 时唯一的巨型规划组永远被保护 —— 而"一个大规划 + 一堆小步"恰是最常见的任务形态，保护它等于不省。改为 0 后实测回放归零且任务正常（摘要保留 text + 工具调用 + 结果预览）。

### 残留边界（诚实）

- 本场跑到 600s 超时被杀 —— 是 max 档规划思考本身极重（step1 一次 44K tokens），非插件故障；省 token 不等于省时间
- metrics-logger 在本场被杀进程时未落盘（缓冲丢失），观测插件不适合被 kill 的场景
- sweep 摘要是有损压缩：模型丢失思考细节，保留结论。对"靠思考细节才能继续"的任务是理论风险，实测未发生

## 31. 生成端塑形 + 蒸馏摘要【已验证】

### shape（A+C 合并，默认开）

每个 turn 首个 pre-step 注入一条常驻指令：少想、不重复推导、把计划写进文件而不是记在思考里。这是第一个打到**生成端**的机制。

A/B 实测（网关 v4.1-flash，两组任务各一对）：
- 关：1,477 / 472 字符思考
- 开：536 / 406 字符思考（-52% 均值）
- 指令实测落地（guardianMsgs 各 1），任务全部完成；开组有一场测试失败→自修复，思考量仍低于关组

诚实边界：网关思考地板浅，绝对量小；官方大思考路由上未测（方向一致、量级未知）。

### sweep.distill（B，默认关）

可选升级：清思考组时用一次同路由 `reasoningEffort: 'low'` 的辅助调用把原文蒸馏成"状态笔记"（计划/当前步/决策/事实/待办），替代模板摘要。实测产出明显更丰富（真实提取了计划与决策），任务完成。<1500 字符的组不蒸馏（笔记可能比原文长）。

成本：每次清扫多一次 ~1.5K maxTokens 的便宜调用 —— 所以 opt-in。

### C 的落地方式

状态外化没有做成独立机制，而是折进了 shape 指令（"把计划写进 plan.md"）—— 零成本拿到大部分收益。

## 32. 质量优先修正：只删重复，不删深度【已落地】

用户质疑：max 模式的意义就是深度思考，压思考量可能伤输出质量。审查后发现两个默认项确实越界：

1. **shape 指令原文案含 "keep reasoning brief"** —— 直接压深度。改为只针对重复："不重复推导已定结论、把计划写进文件"，全文无"少想"字样。
2. **effort.routineLevel 默认 'off'** —— 机械步完全无思考。改默认 **'low'**：大幅省的同时保留薄判断层；'off' 仍是可选（配 `routineLevel: 'off'`）。

修正后的设计原则（发布口径）：

> **只删重复，不删深度。** sweep 删的是"每轮重发"（结论留在摘要里），dedupe 删一字不差的重复证据，shape 只拦"重新推导已 settle 的事"，nudges 是可忽略的建议。真正减少深度的只有 effort 降档——默认 low 而非 off，且有报错/绕圈自动升档兜底。

A/B 里 -52% 的思考降幅是旧文案（含 brief）下测的；新文案预期省得更少但更不伤质量 —— 这是正确的取舍。

## 33. 质量 A/B：带陷阱调试任务【已验证】

场景：`sandbox/qab` 一个 CSV 汇总脚本，`amount` 字段前导空格导致 `TX-005` 被静默跳过（total 少 500）。考察点：调试中模型需要追溯"为什么这行被丢"，且激进清扫（minChars=200，比默认激进 10 倍）中途清掉旧推理。

| | 无插件基线 | guardian（激进清扫） |
|---|---|---|
| 结论 | 空格 bug，parseCSV 处统一 trim 修复 | 空格 bug，校验处 trim 修复 |
| 正确性 | ✅ total=2480.75 count=9 | ✅ total=2480.75 count=9 |
| sweep 触发 | — | 2 次（中途旧推理已被摘要替换） |
| 步数 | 6 | 5 |

**结论：在清扫激进 10 倍于默认值的条件下，诊断质量和修复正确性与基线等价** —— 被清掉的推理没妨碍模型完成需要追溯的调试任务。

诚实边界：单任务单模型单次；更难的"需要推翻多轮结论"的任务未测；但"激进清扫下质量等价"已有实证。

## 34. 大任务质量 A/B：正则引擎（真正复杂场景）【已验证，含一次失败教训】

任务：从零实现回溯正则引擎（字面量 `.` `*` `+` `?` 字符类 分组 交替 锚点），配套断言测试并跑通。官方路由（deepseek max 档），三场：

### 基线（无插件，rxA/rtA）

12 个请求全程 `max`，回放从 132K 涨到 **180K 字符/轮**，请求体涨到 286KB，**回放总量 1,645,757 字符**。任务完成且超规格：模型跑 node 对照原生正则语义，复刻了 RepeatMatcher 空迭代回滚行为，63 断言 + 30 个交叉对照全过。

### guardian 第一版（rxB/rtB）：插件自身造成质量损伤 ❌

session 证据链：seq=23 sweep 正常（107K 规划思考→摘要）；seq=25/49/71 loop 提醒连升三档，最强档"stop tool calls entirely"时模型正在修一个真实的函数名冲突 bug，听话停手 → 文件留在半修复坏状态。

**根因**：`turnReasoningChars` 预算默认 60K 字符，但 max 档一个正常规划步就 107K —— 预算信号把"贵的有效思考"误判为"打转"，每 4 步升一档直到发出停手指令。

**修复**：① 预算/时间信号只发最软提醒，永不升级；② 最强档文案删掉"停止所有工具调用"，改为"收尾当前工作并直接答"；③ 预算默认提到 200K。

### guardian 修复版（rxC/rtC）：质量等价 ✅

22 个请求，**回放总量仅 23,176 字符（比基线少 98.6%）**，请求体稳定 62-82KB，机械步 `effort=low`。提醒层面：5 次 sweep + 2 次最软 L1 + 1 次批量提示，**零升级**。

质量关键点：模型中途发现自己的测试预期写错（把局部匹配语义误当全匹配），**主动修正预期后 60/60 断言全过** —— 证明清扫掉旧推理后模型仍能正常推翻自己的结论。产物满足任务全部要求（引擎 + ≥10 断言）。

### 结论

- **成本**：大任务上回放税是真实且巨大的（基线 1.65M 字符纯回放），插件压掉 98.6%。
- **质量**：修复后的插件在复杂调试+多文件任务上与基线等价；且这次失败证明"软提醒"若措辞过硬依然会伤质量，文案和升级路径必须当成功能正确性来测。
- **诚实边界**：单任务单模型；baseline 产物更丰富（多了捕获组和原生对照），guardian 产物满足规格但更精简 —— 这是模型自由度内的差异，不能归因于插件。

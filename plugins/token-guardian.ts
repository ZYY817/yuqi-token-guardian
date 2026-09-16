/**
 * Token guardian — one plugin that reduces wasted tokens without harming the
 * task. Install once; defaults only do things that can never hurt the answer.
 *
 * Three layers, by how much they can hurt:
 *
 *   PURE SAVINGS (always on) — delete redundancy, never touch generation:
 *     sweep    old reasoning groups become one-line summaries (replay tax → 0,
 *              verified on the official DeepSeek route: wire reasoning_content
 *              went to zero, all requests 200, task completed)
 *     dedupe   repeated identical read results collapse to a pointer
 *     prune    oversized tool results shrink via the official pruner
 *
 *   SOFT NUDGES (always on) — inject advisory text the model may ignore:
 *     shape    once per turn: do not re-derive settled conclusions, write
 *              plans to files — targets repetition, never says "think less"
 *     loops    reasoning echo / same-tool streak / no-progress / over-budget
 *              produce a "converge now" reminder — never a cutoff
 *     batch    serial one-read-per-step runs get a "batch your reads" hint
 *     effort   routine steps run at 'low' instead of the session level —
 *              a reduction, not a cut; 'off' and harder settings are opt-in
 *
 *   HARD LIMITS (opt-in, default OFF) — can cut a turn short, so nothing here
 *   is enabled unless the user asks:
 *     caps.planningMaxTokens    ceiling on step-1 planning output
 *     caps.mechanicalMaxTokens  ceiling on routine-step output
 *   Hard ceilings self-disable after `caps.maxTruncations` capped turns die on
 *   max-tokens, so a stuck model is never trapped by its own safety net.
 *
 * All mutations use the official shadow-price + surface-replace protocol and
 * run from `agent/pre-step` — session appends are not reentrant during event
 * publication. Every feature block is fail-contained: one broken feature must
 * never fail the user's turn.
 */
import { randomUUID } from 'node:crypto'

export const name = 'yuqi-token-guardian'

export interface Config {
  sweep?: {
    /** Set false to disable. Default true. */
    enabled?: boolean
    /**
     * Newest reasoning groups kept intact. Default 0 — a single huge planning
     * burst is otherwise protected forever, which is exactly the dominant
     * replay cost in the common one-big-plan task shape. The replacement
     * summary preserves the assistant text, tool calls, and result previews.
     */
    keepLatest?: number
    /** Minimum reasoning chars worth sweeping. Default 2000. */
    minChars?: number
    /** Per-result preview chars kept in the summary. Default 400. */
    resultPreviewChars?: number
    /**
     * Distill swept reasoning into a model-written state note instead of the
     * fixed template. Default false — each sweep then costs one cheap
     * low-effort call on the conversation's own route. Falls back to the
     * template when the call fails or no llm service is present.
     */
    distill?: boolean
    /** Optional provider/model pair for the distiller (both or neither). */
    distillProvider?: string
    distillModel?: string
    /** Reasoning chars sent to the distiller, head-biased. Default 20000. */
    distillInputChars?: number
  }
  dedupe?: {
    enabled?: boolean
    /** Tool names whose identical results may collapse. Default ['read']. */
    tools?: string[]
    minChars?: number
  }
  prune?: {
    enabled?: boolean
  }
  loops?: {
    enabled?: boolean
    /** Consecutive same-name calls regardless of args. Default 6; 0 off. */
    sameToolStreak?: number
    /** Consecutive steps with no mutating call. Default 8; 0 off. */
    noProgressSteps?: number
    /** Consecutive messages with identical reasoning signature. Default 2; 0 off. */
    reasoningRepeat?: number
    /** Cumulative reasoning chars per turn that trigger a converge nudge. Default 300000; 0 off. Budget signals only ever produce the softest directive — a busy-but-productive turn must never be told to stop. */
    turnReasoningChars?: number
    /** Wall-clock minutes per turn that trigger. Default 10; 0 off. */
    turnMinutes?: number
    /** Tools counted as making progress. */
    mutatingTools?: string[]
    /** Steps between nudges. Default 4. */
    cooldownSteps?: number
  }
  batch?: {
    enabled?: boolean
    /** Consecutive single-read-only steps before the hint. Default 2. */
    streak?: number
    readOnlyTools?: string[]
    cooldownSteps?: number
  }
  shape?: {
    /** Inject a standing work-hygiene directive once per turn. Default true. */
    enabled?: boolean
    /** Override the directive text. */
    text?: string
  }
  effort?: {
    /**
     * Routine-step effort level. Default 'low' — 'off' saves more but removes
     * thinking entirely from steps that may still need judgment; refused when
     * the route does not offer the level.
     */
    routineLevel?: string
    /** Never touch steps while the user explicitly chose a level. Default true. */
    respectExplicit?: boolean
    /** totalTokens/contextWindow ratio forcing routineLevel. Default 0.7. */
    pressureCut?: number
  }
  caps?: {
    /** Step-1 planning output ceiling. Default 0 = disabled. */
    planningMaxTokens?: number
    /** Routine-step output ceiling. Default 0 = disabled. */
    mechanicalMaxTokens?: number
    /** Capped turns allowed to die on max-tokens before caps retire. Default 2. */
    maxTruncations?: number
  }
}

const TEXT_CAP = 2000
const ARGS_CAP = 200
const CP = (s: string): number => Array.from(s).length
const MUTATING = ['write', 'edit', 'multi_edit', 'bash', 'pwsh', 'notebook_edit']
const READ_ONLY = ['read', 'glob', 'grep', 'list', 'lsp']
const BATCH_HINT =
  '<system-reminder>Batching: when several independent read-only tool calls are pending ' +
  '(e.g. reading multiple files), issue them in a single step instead of one per step. ' +
  'Each extra round-trip re-sends the full prompt and history.</system-reminder>'
// Deliberately says nothing about thinking "briefly" — depth on genuinely new
// problems is the point of the mode. This targets only waste: re-deriving
// settled conclusions, re-planning, re-checking answered questions.
const SHAPE_DIRECTIVE =
  '<system-reminder>Do not re-derive or re-litigate conclusions already ' +
  'established earlier in this session — treat settled results as settled and ' +
  'spend reasoning only on genuinely new decisions. When a task needs a plan, ' +
  'write it to a file (e.g. plan.md) and refer to that file instead of ' +
  're-planning in your head.</system-reminder>'
// The ladder forbids INVESTIGATION, never the work itself — a directive that
// says "stop tool calls" mid-fix leaves the artifact broken (observed on a
// real max-effort run: the model complied and shipped a half-renamed file).
const DIRECTIVES = [
  '<system-reminder>Loop detected: recent steps have deliberated without producing changes. Commit to a concrete action now — write the file, run the command, or state what is missing and stop investigating.</system-reminder>',
  '<system-reminder>You are still repeating the same kind of step without progress. Stop exploring: either apply the concrete change the task needs now, or report the blocker in your final answer.</system-reminder>',
  '<system-reminder>The investigation is going in circles. Finish what you are doing with the evidence already collected: apply the fix or write the answer, then stop investigating further.</system-reminder>',
]

/** Recursively sort object keys so identical argument sets collapse regardless of key order. */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((k) => [k, sortValue((value as Record<string, unknown>)[k])]),
    )
  }
  return value
}

/** Signature of a message's reasoning: normalized head + tail + length bucket. */
function reasoningSignature(content: any[]): string | undefined {
  const text = content
    .filter((b: any) => b?.type === 'reasoning')
    .map((b: any) => (typeof b.text === 'string' ? b.text : ''))
    .join('')
  if (text.length < 400) return undefined
  const norm = text.replace(/\s+/g, ' ')
  return `${norm.slice(0, 300)}|${norm.slice(-300)}|${Math.round(text.length / 500)}`
}

function textChars(blocks: readonly any[]): number {
  let n = 0
  for (const b of blocks) if (b?.type === 'text' && typeof b.text === 'string') n += CP(b.text)
  return n
}

/** Open tool-call count over the surface — nonzero means a span is unclosed. */
function openCalls(session: any): number {
  let open = 0
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event?.type === 'assistant/message') {
      open += (event.data?.message?.content ?? []).filter((b: any) => b?.type === 'tool-call').length
    } else if (event?.type === 'tool/result') {
      open -= 1
    }
  }
  return open
}

interface ResultRef { seq: number; step: number; turn: number }

interface State {
  // effort/intent
  intent?: string
  explicit: boolean
  intentRecovered: boolean
  routeSupportsEffort: boolean
  offeredEfforts?: string[] | null
  lowRejected: boolean
  lastWritten?: string
  lastCapWritten?: number
  userMaxTokens?: number
  cappedThisTurn: boolean
  truncateCount: number
  contextWindow: number
  // tool tracking
  toolError: boolean
  lastToolKey?: string
  repeatCount: number
  lastToolName?: string
  toolStreak: number
  stepsSinceMutation: number
  // dedupe
  callKeys: Map<string, string>
  results: Map<string, ResultRef[]>
  // loops/budget/batch
  lastReasoningSig?: string
  reasoningStreak: number
  stepCount: number
  nudgeLevel: number
  lastNudgeStep: number
  turnStartedAt: number
  turnStepCount: number
  turnReasoningChars: number
  batchStreak: number
  batchSentAt: number
  shapePending: boolean
  // sweep
  swept: Set<number>
  lastProvider?: string
  lastModel?: string
}

export function apply(ctx: any, config: Config): void {
  const sweepCfg = {
    enabled: true, keepLatest: 0, minChars: 2000, resultPreviewChars: 400,
    distill: false, distillInputChars: 20000, ...config.sweep,
  }
  const dedupeCfg = { enabled: true, tools: ['read'], minChars: 2000, ...config.dedupe }
  const loopsCfg = {
    enabled: true, sameToolStreak: 6, noProgressSteps: 8, reasoningRepeat: 2,
    turnReasoningChars: 300000, turnMinutes: 10, cooldownSteps: 4,
    ...config.loops,
  }
  const batchCfg = { enabled: true, streak: 2, readOnlyTools: READ_ONLY, cooldownSteps: 0, ...config.batch }
  const shapeCfg = { enabled: true, text: SHAPE_DIRECTIVE, ...config.shape }
  const effortCfg = { routineLevel: 'low', respectExplicit: true, pressureCut: 0.7, ...config.effort }
  const capsCfg = { planningMaxTokens: 0, mechanicalMaxTokens: 0, maxTruncations: 2, ...config.caps }
  const pruneEnabled = config.prune?.enabled !== false
  const dedupeTools = new Set(dedupeCfg.tools)
  const mutating = new Set(loopsCfg.mutatingTools ?? MUTATING)
  const readOnly = new Set(batchCfg.readOnlyTools ?? READ_ONLY)

  const states = new WeakMap<any, State>()
  const stateOf = (session: any): State => {
    let s = states.get(session)
    if (!s) {
      s = {
        explicit: false, intentRecovered: false, routeSupportsEffort: false, lowRejected: false,
        cappedThisTurn: false, truncateCount: 0, contextWindow: 0,
        toolError: false, repeatCount: 0, toolStreak: 0, stepsSinceMutation: 0,
        callKeys: new Map(), results: new Map(),
        reasoningStreak: 0, stepCount: 0, nudgeLevel: 0, lastNudgeStep: -1,
        turnStartedAt: 0, turnStepCount: 0, turnReasoningChars: 0,
        batchStreak: 0, batchSentAt: -1, shapePending: false, swept: new Set(),
      }
      states.set(session, s)
    }
    return s
  }

  // ------------------------------------------------------------------ events
  ctx.on('session/event', (session: any, event: any) => {
    const s = stateOf(session)
    const data = event?.data ?? {}
    switch (event?.type) {
      case 'turn/start':
        s.cappedThisTurn = false
        s.toolError = false
        s.turnStartedAt = Date.now()
        s.turnStepCount = 0
        s.turnReasoningChars = 0
        s.shapePending = shapeCfg.enabled
        break
      case 'turn/end':
        if (data.reason?.kind === 'max-tokens' && s.cappedThisTurn) {
          s.truncateCount++
          ctx.logger?.warn?.(`token-guardian: capped turn hit max-tokens (count=${s.truncateCount})`)
        }
        break
      case 'step/start':
        s.stepCount++
        s.turnStepCount++
        s.stepsSinceMutation++
        break
      case 'request/header': {
        const header = data.header ?? {}
        const value = header.config?.reasoningEffort
        const defaulted = header.adapterDefaults?.reasoningEffort === true
        if (!s.intentRecovered) {
          s.intentRecovered = true
          // The log's 'initial' header predates any plugin write — the only
          // authoritative record of user-vs-adapter intent across restarts.
          const total = session.seq ?? 0
          for (let seq = 0; seq < total; seq++) {
            const e = session.eventAt(seq)
            if (e?.type === 'request/header' && e.data?.reason === 'initial') {
              const v = e.data.header?.config?.reasoningEffort
              s.intent = v
              s.routeSupportsEffort = v !== undefined
              s.explicit = v !== undefined && e.data.header?.adapterDefaults?.reasoningEffort !== true
              return
            }
          }
        }
        if (value === s.lastWritten) break
        if (s.intent === undefined) {
          s.intent = value
          s.routeSupportsEffort = value !== undefined
          s.explicit = value !== undefined && !defaulted && data?.reason !== 'resume'
        } else if (!defaulted) {
          s.intent = value
          if (data?.reason !== 'resume') s.explicit = true
        }
        break
      }
      case 'request/context':
        s.contextWindow = data.contextWindow ?? s.contextWindow
        break
      case 'tool/call': {
        const tool = data.name ?? ''
        if (mutating.has(tool)) s.stepsSinceMutation = 0
        s.toolStreak = tool === s.lastToolName ? s.toolStreak + 1 : 1
        s.lastToolName = tool
        const key = tool + ' ' + JSON.stringify(data.arguments ?? '')
        s.repeatCount = key === s.lastToolKey ? s.repeatCount + 1 : 1
        s.lastToolKey = key
        if (dedupeCfg.enabled && dedupeTools.has(tool) && typeof data.arguments === 'string' && data.callId !== undefined) {
          try {
            s.callKeys.set(data.callId, tool + ' ' + JSON.stringify(sortValue(JSON.parse(data.arguments))))
          } catch {
            s.callKeys.set(data.callId, tool + ' ' + data.arguments)
          }
        }
        break
      }
      case 'tool/result': {
        const blocks = data.message?.content ?? []
        s.toolError = s.toolError || blocks.some((b: any) => b?.isError === true) || data.error !== undefined
        if (dedupeCfg.enabled && event?.surfaceOp?.op !== 'replace') {
          const callId = data.message?.source?.callId
          const result = blocks[0]
          const key = callId === undefined ? undefined : s.callKeys.get(callId)
          if (key !== undefined && result !== undefined && result.isError !== true) {
            const refs = s.results.get(key) ?? []
            refs.push({ seq: event.seq, step: data.step ?? 0, turn: data.turn ?? 0 })
            s.results.set(key, refs)
          }
        }
        break
      }
      case 'assistant/message': {
        const content = data.message?.content ?? []
        const sig = reasoningSignature(content)
        s.reasoningStreak = sig !== undefined && sig === s.lastReasoningSig ? s.reasoningStreak + 1 : 0
        s.lastReasoningSig = sig
        s.turnReasoningChars += content
          .filter((b: any) => b?.type === 'reasoning')
          .reduce((a: number, b: any) => a + (typeof b.text === 'string' ? b.text.length : 0), 0)
        const calls = content.filter((b: any) => b?.type === 'tool-call')
        s.batchStreak = calls.length === 1 && readOnly.has(calls[0]?.name) ? s.batchStreak + 1 : 0
        break
      }
    }
  })

  // ------------------------------------------------- request: effort + caps
  ctx.on('agent/request', async (payload: any, next: any) => {
    const proposed = await next()
    const agent = payload?.agent
    const step = payload?.step ?? 0
    const s = stateOf(agent?.session)
    s.lastProvider = proposed.provider
    s.lastModel = proposed.model

    if (proposed.maxTokens !== undefined && proposed.maxTokens !== s.lastCapWritten) {
      s.userMaxTokens = proposed.maxTokens
    }
    const stripOurCap = (p: any): any => {
      if (s.lastCapWritten === undefined || p.maxTokens !== s.lastCapWritten) return p
      const { maxTokens: _persistedCap, ...rest } = p
      s.lastCapWritten = undefined
      return s.userMaxTokens !== undefined ? { ...rest, maxTokens: s.userMaxTokens } : rest
    }

    if (step === 1) {
      // Later turns: the step-1 proposal is seeded from this plugin's last
      // persisted header — restore the intended level and strip our cap.
      let base = proposed
      if ((payload?.turn ?? 1) > 1 && s.routeSupportsEffort && s.intent !== undefined) {
        base = stripOurCap(proposed)
        if (base.reasoningEffort === s.lastWritten) {
          s.lastWritten = s.intent
          base = { ...base, reasoningEffort: s.intent }
        }
      }
      const pcap = capsCfg.maxTruncations > 0 && s.truncateCount >= capsCfg.maxTruncations
        ? 0
        : capsCfg.planningMaxTokens
      if (pcap > 0 && base.maxTokens === undefined) {
        s.cappedThisTurn = true
        s.lastCapWritten = pcap
        return { ...base, maxTokens: pcap }
      }
      return base
    }

    const routineLevel = effortCfg.routineLevel
    const governsEffort = routineLevel !== undefined && s.routeSupportsEffort && s.intent !== undefined
    const governsCaps = capsCfg.mechanicalMaxTokens > 0
    if (!governsEffort && !governsCaps) return proposed
    if (governsEffort && effortCfg.respectExplicit && (s.explicit || agent?.options?.reasoningEffort !== undefined)) {
      // An explicit user level disables effort lowering but not the opt-in cap.
      if (!governsCaps) return proposed
    }

    // Writing an effort the route does not declare throws inside prepareCall —
    // resolve the offered list once and refuse an unlisted level.
    if (governsEffort && s.offeredEfforts === undefined && !s.lowRejected) {
      try {
        const info = await ctx.get('llm')?.resolveModelInfo?.(proposed.provider, proposed.model, payload?.signal)
        s.offeredEfforts = info?.reasoning?.efforts?.map((e: any) => e.id) ?? null
      } catch {
        s.offeredEfforts = null
      }
      if (Array.isArray(s.offeredEfforts) && !s.offeredEfforts.includes(routineLevel)) {
        s.lowRejected = true
        ctx.logger?.warn?.(`token-guardian: route ${proposed.provider}/${proposed.model} does not offer effort "${routineLevel}" — routine steps keep the intended level`)
      }
    }

    const breakerOpen = capsCfg.maxTruncations > 0 && s.truncateCount >= capsCfg.maxTruncations
    const cap = breakerOpen ? 0 : capsCfg.mechanicalMaxTokens
    let effort = s.lowRejected ? s.intent : routineLevel
    let reason = 'routine-step'
    if (s.toolError) {
      effort = s.intent
      reason = 'tool-error'
    } else if (s.repeatCount >= 2) {
      effort = s.intent
      reason = 'repeat-loop'
    } else if (s.contextWindow > 0) {
      const meter = ctx.get('tokenMeter')
      if (meter !== undefined) {
        const m = meter.measure(agent.session)
        if (m.totalTokens / s.contextWindow >= effortCfg.pressureCut) reason = 'context-pressure'
      }
    }

    if (governsEffort) {
      s.lastWritten = effort
      if (effort !== proposed.reasoningEffort) {
        ctx.logger?.info?.(`token-guardian: step ${step} ${proposed.reasoningEffort ?? '(default)'} -> ${effort} (${reason})`)
      }
    }
    if (cap > 0) {
      s.cappedThisTurn = true
      s.lastCapWritten = cap
      return governsEffort ? { ...proposed, reasoningEffort: effort, maxTokens: cap } : { ...proposed, maxTokens: cap }
    }
    if (!governsEffort) return proposed
    return { ...stripOurCap(proposed), reasoningEffort: effort }
  })

  // -------------------------------------------------- pre-step: the mutators
  ctx.on('agent/pre-step', async (payload: any, next: any) => {
    const decision = await next()
    if (payload?.signal?.aborted === true) return decision
    const session = payload?.agent?.session
    if (session === undefined) return decision
    const s = stateOf(session)

    // (a) prune oversized tool results via the official pruner
    if (pruneEnabled) {
      try {
        const pruner = ctx.get('toolResultPruner')
        pruner?.pruneSession?.(session)
      } catch (error) {
        ctx.logger?.warn?.('token-guardian: prune failed', error)
      }
    }

    // (b) collapse repeated identical read results to one-line pointers
    if (dedupeCfg.enabled) {
      try {
        const meter = ctx.get('tokenMeter')
        const onSurface = new Set<number>(session.surface.nodes)
        for (const refs of s.results.values()) {
          const live = refs.filter((r) => onSurface.has(r.seq))
          for (const ref of live.slice(0, -1)) {
            const event = session.eventAt(ref.seq)
            const result = event?.data?.message?.content?.[0]
            if (event === undefined || result === undefined || result.isError === true || meter === undefined) continue
            const chars = textChars(result.content ?? [])
            if (chars < dedupeCfg.minChars) continue
            const latest = live[live.length - 1]
            const stub = `[deduped: identical call superseded by the same tool's turn-${latest.turn} step-${latest.step} result — content omitted]`
            const message = {
              ...event.data.message,
              content: [{ ...result, content: [{ type: 'text', text: stub }] }],
            }
            try {
              session.append('compaction/prune', {
                shadowedRange: { start: ref.seq, end: ref.seq },
                shadowedSeqs: [ref.seq],
                shadowedTokenCount: meter.estimateMessage(event.data.message),
              })
              session.append('tool/result', { ...event.data, message }, {
                surfaceOp: { op: 'replace', startSeq: ref.seq, endSeq: ref.seq },
                sourceEventSeqs: [ref.seq],
              })
              ctx.logger?.info?.(`token-guardian: deduped result seq=${ref.seq} (-${chars} chars)`)
            } catch (error) {
              ctx.logger?.warn?.('token-guardian: dedupe failed', error)
            }
          }
        }
      } catch (error) {
        ctx.logger?.warn?.('token-guardian: dedupe scan failed', error)
      }
    }

    // Cheap side call that distills swept reasoning into a state note;
    // returns undefined so the caller falls back to the template summary.
    const distill = async (reasoningText: string): Promise<string | undefined> => {
      const llm = ctx.get('llm')
      if (llm === undefined || s.lastProvider === undefined || s.lastModel === undefined) return undefined
      try {
        const parts: string[] = []
        let failed = false
        for await (const chunk of llm.stream({
          provider: sweepCfg.distillProvider ?? s.lastProvider,
          model: sweepCfg.distillModel ?? s.lastModel,
          reasoningEffort: 'low',
          maxTokens: 1500,
          signal: payload?.signal,
          messages: [{
            id: randomUUID(), role: 'user',
            content: [{ type: 'text', text:
              'Distill this reasoning trace into a compact state note for your future self. ' +
              'Preserve: the plan and current step, decisions made and why, key facts found, ' +
              'open questions — anything needed to continue without re-deriving. ' +
              'Terse bullet points, under 200 words.\n\nREASONING:\n' + reasoningText }],
            source: { kind: 'plugin', plugin: name },
          }],
        })) {
          if (chunk?.type === 'text-delta') parts.push(chunk.text)
          else if (chunk?.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) failed = true
        }
        const text = parts.join('').trim()
        return failed || text.length === 0 ? undefined : text.slice(0, 4000)
      } catch (error) {
        ctx.logger?.warn?.('token-guardian: distill call failed', error)
        return undefined
      }
    }

    // (c) sweep old reasoning groups into bounded user-message summaries.
    // Group membership is matched by tool-call id; an unclosed span (e.g. a
    // max-tokens orphan call) is abandoned rather than disabling the sweep,
    // and spans containing foreign node types are refused.
    if (sweepCfg.enabled) {
      try {
        const meter = ctx.get('tokenMeter')
        if (meter !== undefined) {
          const surfaceSeqs = [...session.surface.nodes]
          const events = surfaceSeqs.map((seq: number) => session.eventAt(seq))
          interface Group { start: number; end: number; seqs: number[]; chars: number; event: any }
          const groups: Group[] = []
          let openIds = new Set<string>()
          let groupStart = -1
          let foreign = false
          const closeGroup = (endIdx: number): void => {
            const head = events[groupStart]
            const chars = (head?.data?.message?.content ?? [])
              .filter((b: any) => b?.type === 'reasoning')
              .reduce((a: number, b: any) => a + (b.text?.length ?? 0), 0)
            if (!foreign && chars >= sweepCfg.minChars) {
              groups.push({
                start: surfaceSeqs[groupStart],
                end: surfaceSeqs[endIdx],
                seqs: surfaceSeqs.slice(groupStart, endIdx + 1),
                chars,
                event: head,
              })
            }
            groupStart = -1
            foreign = false
          }
          for (let i = 0; i < events.length; i++) {
            const event = events[i]
            if (event?.type === 'assistant/message') {
              if (openIds.size > 0) { groupStart = -1; foreign = false }
              const calls = (event.data?.message?.content ?? [])
                .filter((b: any) => b?.type === 'tool-call')
              openIds = new Set(calls.map((b: any) => b.id))
              groupStart = i
              if (openIds.size === 0) closeGroup(i)
            } else if (event?.type === 'tool/result') {
              const callId = event.data?.message?.source?.callId
              if (groupStart >= 0) {
                if (callId !== undefined) openIds.delete(callId)
                if (openIds.size === 0) closeGroup(i)
              }
            } else if (groupStart >= 0) {
              foreign = true
            }
          }
          const victims = groups
            .slice(0, Math.max(0, groups.length - sweepCfg.keepLatest))
            .filter(({ start }) => !s.swept.has(start))
          for (const { start, end, seqs, chars, event } of victims) {
            const content = event.data.message.content
            const text = content
              .filter((b: any) => b?.type === 'text')
              .map((b: any) => b.text as string)
              .join('')
              .slice(0, TEXT_CAP)
            // Below ~1500 chars the template is already as dense as a note.
            const distilled = sweepCfg.distill && chars >= 1500
              ? await distill(
                  content
                    .filter((b: any) => b?.type === 'reasoning')
                    .map((b: any) => (typeof b.text === 'string' ? b.text : ''))
                    .join('\n')
                    .slice(0, sweepCfg.distillInputChars),
                )
              : undefined
            const calls = content
              .filter((b: any) => b?.type === 'tool-call')
              .map((b: any) => `${b.name}(${typeof b.arguments === 'string' ? b.arguments.slice(0, ARGS_CAP) : ''})`)
            const results = seqs.slice(1).map((seq) => {
              const result = session.eventAt(seq)
              const block = result?.data?.message?.content?.[0]
              const preview = (Array.isArray(block?.content) ? block.content : [])
                .map((b: any) => (typeof b?.text === 'string' ? b.text : ''))
                .join('')
                .slice(0, sweepCfg.resultPreviewChars)
              const failed = block?.isError === true ? ' ERROR' : ''
              return `${preview.length > 0 ? preview : '(no output)'}${failed}`
            })
            const summary = [
              `[Earlier step compacted by ${name}: ${chars} reasoning chars omitted.`,
              distilled !== undefined ? `State note:\n${distilled}` : '',
              text.length > 0 ? `Assistant text: ${text}` : '',
              calls.length > 0 ? `Tool calls made: ${calls.join('; ')}` : '',
              ...results.map((r, i) => `Result ${i + 1}: ${r}`),
              ']',
            ].filter((line) => line.length > 0).join('\n')
            try {
              session.append('compaction/prune', {
                shadowedRange: { start, end },
                shadowedSeqs: seqs,
                shadowedTokenCount: seqs.reduce((total: number, seq: number) => {
                  const e = session.eventAt(seq)
                  return total + (e === undefined ? 0 : meter.estimateMessage(e.data.message ?? e.data))
                }, 0),
              })
              session.append('user/message', {
                id: randomUUID(),
                role: 'user',
                content: [{ type: 'text', text: summary }],
                source: { kind: 'plugin', plugin: name },
              }, {
                surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
                sourceEventSeqs: seqs,
              })
              s.swept.add(start)
              ctx.logger?.info?.(`token-guardian: swept reasoning seqs ${start}-${end} (-${chars} chars)`)
            } catch (error) {
              ctx.logger?.warn?.('token-guardian: sweep replace failed', error)
            }
          }
        }
      } catch (error) {
        ctx.logger?.warn?.('token-guardian: sweep failed', error)
      }
    }

    // (d) advisory nudges — never a cutoff, only durable text the model may ignore
    if (decision?.kind !== 'enter') return decision
    const extras: any[] = []
    try {
      if (s.shapePending) {
        s.shapePending = false
        extras.push({
          id: randomUUID(), role: 'user',
          content: [{ type: 'text', text: shapeCfg.text }],
          source: { kind: 'plugin', plugin: name },
        })
      }
      const cooling = s.lastNudgeStep >= 0 && s.stepCount - s.lastNudgeStep < loopsCfg.cooldownSteps
      if (loopsCfg.enabled && !cooling) {
        // Loop signals (echo / streak / no-progress) may escalate the ladder;
        // budget signals may not — an expensive-but-productive turn must never
        // be pushed toward the stop-directive.
        const reasons: string[] = []
        let loopSignal = false
        if (loopsCfg.reasoningRepeat > 0 && s.reasoningStreak >= loopsCfg.reasoningRepeat) { reasons.push('reasoning-echo'); loopSignal = true }
        if (loopsCfg.sameToolStreak > 0 && s.toolStreak >= loopsCfg.sameToolStreak) { reasons.push(`same-tool:${s.lastToolName}`); loopSignal = true }
        if (loopsCfg.noProgressSteps > 0 && s.stepsSinceMutation >= loopsCfg.noProgressSteps) { reasons.push('no-progress'); loopSignal = true }
        if (loopsCfg.turnReasoningChars > 0 && s.turnReasoningChars >= loopsCfg.turnReasoningChars) {
          reasons.push(`reasoning-budget:${s.turnReasoningChars}ch`)
        }
        if (loopsCfg.turnMinutes > 0 && s.turnStartedAt > 0 && Date.now() - s.turnStartedAt >= loopsCfg.turnMinutes * 60_000) {
          reasons.push('time-budget')
        }
        if (reasons.length > 0 && openCalls(session) === 0) {
          extras.push({
            id: randomUUID(), role: 'user',
            content: [{ type: 'text', text: DIRECTIVES[loopSignal ? Math.min(s.nudgeLevel, DIRECTIVES.length - 1) : 0] }],
            source: { kind: 'plugin', plugin: name },
          })
          s.nudgeLevel++
          s.lastNudgeStep = s.stepCount
          s.reasoningStreak = 0
          s.toolStreak = 0
          s.stepsSinceMutation = 0
          ctx.logger?.warn?.(`token-guardian: ${reasons.join('+')} -> directive level ${s.nudgeLevel}`)
        }
      }
      const batchCooling = s.batchSentAt >= 0 && (batchCfg.cooldownSteps === 0 || s.stepCount - s.batchSentAt < batchCfg.cooldownSteps)
      if (batchCfg.enabled && s.batchStreak >= batchCfg.streak && !batchCooling && openCalls(session) === 0) {
        extras.push({
          id: randomUUID(), role: 'user',
          content: [{ type: 'text', text: BATCH_HINT }],
          source: { kind: 'plugin', plugin: name },
        })
        s.batchSentAt = s.stepCount
        s.batchStreak = 0
        ctx.logger?.info?.('token-guardian: appended batching hint')
      }
    } catch (error) {
      ctx.logger?.warn?.('token-guardian: nudge failed', error)
    }
    return extras.length === 0 ? decision : { ...decision, messages: [...decision.messages, ...extras] }
  })
}

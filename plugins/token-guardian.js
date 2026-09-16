import { randomUUID } from "node:crypto";
const name = "yuqi-token-guardian";
const TEXT_CAP = 2e3;
const ARGS_CAP = 200;
const CP = (s) => Array.from(s).length;
const MUTATING = ["write", "edit", "multi_edit", "bash", "pwsh", "notebook_edit"];
const READ_ONLY = ["read", "glob", "grep", "list", "lsp"];
const BATCH_HINT = "<system-reminder>Batching: when several independent read-only tool calls are pending (e.g. reading multiple files), issue them in a single step instead of one per step. Each extra round-trip re-sends the full prompt and history.</system-reminder>";
const SHAPE_DIRECTIVE = "<system-reminder>Do not re-derive or re-litigate conclusions already established earlier in this session \u2014 treat settled results as settled and spend reasoning only on genuinely new decisions. When a task needs a plan, write it to a file (e.g. plan.md) and refer to that file instead of re-planning in your head.</system-reminder>";
const DIRECTIVES = [
  "<system-reminder>Loop detected: recent steps have deliberated without producing changes. Commit to a concrete action now \u2014 write the file, run the command, or state what is missing and stop investigating.</system-reminder>",
  "<system-reminder>You are still repeating the same kind of step without progress. Stop exploring: either apply the concrete change the task needs now, or report the blocker in your final answer.</system-reminder>",
  "<system-reminder>The investigation is going in circles. Finish what you are doing with the evidence already collected: apply the fix or write the answer, then stop investigating further.</system-reminder>"
];
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((k) => [k, sortValue(value[k])])
    );
  }
  return value;
}
function reasoningSignature(content) {
  const text = content.filter((b) => b?.type === "reasoning").map((b) => typeof b.text === "string" ? b.text : "").join("");
  if (text.length < 400) return void 0;
  const norm = text.replace(/\s+/g, " ");
  return `${norm.slice(0, 300)}|${norm.slice(-300)}|${Math.round(text.length / 500)}`;
}
function textChars(blocks) {
  let n = 0;
  for (const b of blocks) if (b?.type === "text" && typeof b.text === "string") n += CP(b.text);
  return n;
}
function openCalls(session) {
  let open = 0;
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event?.type === "assistant/message") {
      open += (event.data?.message?.content ?? []).filter((b) => b?.type === "tool-call").length;
    } else if (event?.type === "tool/result") {
      open -= 1;
    }
  }
  return open;
}
function apply(ctx, config) {
  const sweepCfg = {
    enabled: true,
    keepLatest: 0,
    minChars: 2e3,
    resultPreviewChars: 400,
    distill: false,
    distillInputChars: 2e4,
    ...config.sweep
  };
  const dedupeCfg = { enabled: true, tools: ["read"], minChars: 2e3, ...config.dedupe };
  const loopsCfg = {
    enabled: true,
    sameToolStreak: 6,
    noProgressSteps: 8,
    reasoningRepeat: 2,
    turnReasoningChars: 3e5,
    turnMinutes: 10,
    cooldownSteps: 4,
    ...config.loops
  };
  const batchCfg = { enabled: true, streak: 2, readOnlyTools: READ_ONLY, cooldownSteps: 0, ...config.batch };
  const shapeCfg = { enabled: true, text: SHAPE_DIRECTIVE, ...config.shape };
  const effortCfg = { routineLevel: "low", respectExplicit: true, pressureCut: 0.7, ...config.effort };
  const capsCfg = { planningMaxTokens: 0, mechanicalMaxTokens: 0, maxTruncations: 2, ...config.caps };
  const pruneEnabled = config.prune?.enabled !== false;
  const dedupeTools = new Set(dedupeCfg.tools);
  const mutating = new Set(loopsCfg.mutatingTools ?? MUTATING);
  const readOnly = new Set(batchCfg.readOnlyTools ?? READ_ONLY);
  const states = /* @__PURE__ */ new WeakMap();
  const stateOf = (session) => {
    let s = states.get(session);
    if (!s) {
      s = {
        explicit: false,
        intentRecovered: false,
        routeSupportsEffort: false,
        lowRejected: false,
        cappedThisTurn: false,
        truncateCount: 0,
        contextWindow: 0,
        toolError: false,
        repeatCount: 0,
        toolStreak: 0,
        stepsSinceMutation: 0,
        callKeys: /* @__PURE__ */ new Map(),
        results: /* @__PURE__ */ new Map(),
        reasoningStreak: 0,
        stepCount: 0,
        nudgeLevel: 0,
        lastNudgeStep: -1,
        turnStartedAt: 0,
        turnStepCount: 0,
        turnReasoningChars: 0,
        batchStreak: 0,
        batchSentAt: -1,
        shapePending: false,
        swept: /* @__PURE__ */ new Set()
      };
      states.set(session, s);
    }
    return s;
  };
  ctx.on("session/event", (session, event) => {
    const s = stateOf(session);
    const data = event?.data ?? {};
    switch (event?.type) {
      case "turn/start":
        s.cappedThisTurn = false;
        s.toolError = false;
        s.turnStartedAt = Date.now();
        s.turnStepCount = 0;
        s.turnReasoningChars = 0;
        s.shapePending = shapeCfg.enabled;
        break;
      case "turn/end":
        if (data.reason?.kind === "max-tokens" && s.cappedThisTurn) {
          s.truncateCount++;
          ctx.logger?.warn?.(`token-guardian: capped turn hit max-tokens (count=${s.truncateCount})`);
        }
        break;
      case "step/start":
        s.stepCount++;
        s.turnStepCount++;
        s.stepsSinceMutation++;
        break;
      case "request/header": {
        const header = data.header ?? {};
        const value = header.config?.reasoningEffort;
        const defaulted = header.adapterDefaults?.reasoningEffort === true;
        if (!s.intentRecovered) {
          s.intentRecovered = true;
          const total = session.seq ?? 0;
          for (let seq = 0; seq < total; seq++) {
            const e = session.eventAt(seq);
            if (e?.type === "request/header" && e.data?.reason === "initial") {
              const v = e.data.header?.config?.reasoningEffort;
              s.intent = v;
              s.routeSupportsEffort = v !== void 0;
              s.explicit = v !== void 0 && e.data.header?.adapterDefaults?.reasoningEffort !== true;
              return;
            }
          }
        }
        if (value === s.lastWritten) break;
        if (s.intent === void 0) {
          s.intent = value;
          s.routeSupportsEffort = value !== void 0;
          s.explicit = value !== void 0 && !defaulted && data?.reason !== "resume";
        } else if (!defaulted) {
          s.intent = value;
          if (data?.reason !== "resume") s.explicit = true;
        }
        break;
      }
      case "request/context":
        s.contextWindow = data.contextWindow ?? s.contextWindow;
        break;
      case "tool/call": {
        const tool = data.name ?? "";
        if (mutating.has(tool)) s.stepsSinceMutation = 0;
        s.toolStreak = tool === s.lastToolName ? s.toolStreak + 1 : 1;
        s.lastToolName = tool;
        const key = tool + " " + JSON.stringify(data.arguments ?? "");
        s.repeatCount = key === s.lastToolKey ? s.repeatCount + 1 : 1;
        s.lastToolKey = key;
        if (dedupeCfg.enabled && dedupeTools.has(tool) && typeof data.arguments === "string" && data.callId !== void 0) {
          try {
            s.callKeys.set(data.callId, tool + " " + JSON.stringify(sortValue(JSON.parse(data.arguments))));
          } catch {
            s.callKeys.set(data.callId, tool + " " + data.arguments);
          }
        }
        break;
      }
      case "tool/result": {
        const blocks = data.message?.content ?? [];
        s.toolError = s.toolError || blocks.some((b) => b?.isError === true) || data.error !== void 0;
        if (dedupeCfg.enabled && event?.surfaceOp?.op !== "replace") {
          const callId = data.message?.source?.callId;
          const result = blocks[0];
          const key = callId === void 0 ? void 0 : s.callKeys.get(callId);
          if (key !== void 0 && result !== void 0 && result.isError !== true) {
            const refs = s.results.get(key) ?? [];
            refs.push({ seq: event.seq, step: data.step ?? 0, turn: data.turn ?? 0 });
            s.results.set(key, refs);
          }
        }
        break;
      }
      case "assistant/message": {
        const content = data.message?.content ?? [];
        const sig = reasoningSignature(content);
        s.reasoningStreak = sig !== void 0 && sig === s.lastReasoningSig ? s.reasoningStreak + 1 : 0;
        s.lastReasoningSig = sig;
        s.turnReasoningChars += content.filter((b) => b?.type === "reasoning").reduce((a, b) => a + (typeof b.text === "string" ? b.text.length : 0), 0);
        const calls = content.filter((b) => b?.type === "tool-call");
        s.batchStreak = calls.length === 1 && readOnly.has(calls[0]?.name) ? s.batchStreak + 1 : 0;
        break;
      }
    }
  });
  ctx.on("agent/request", async (payload, next) => {
    const proposed = await next();
    const agent = payload?.agent;
    const step = payload?.step ?? 0;
    const s = stateOf(agent?.session);
    s.lastProvider = proposed.provider;
    s.lastModel = proposed.model;
    if (proposed.maxTokens !== void 0 && proposed.maxTokens !== s.lastCapWritten) {
      s.userMaxTokens = proposed.maxTokens;
    }
    const stripOurCap = (p) => {
      if (s.lastCapWritten === void 0 || p.maxTokens !== s.lastCapWritten) return p;
      const { maxTokens: _persistedCap, ...rest } = p;
      s.lastCapWritten = void 0;
      return s.userMaxTokens !== void 0 ? { ...rest, maxTokens: s.userMaxTokens } : rest;
    };
    if (step === 1) {
      let base = proposed;
      if ((payload?.turn ?? 1) > 1 && s.routeSupportsEffort && s.intent !== void 0) {
        base = stripOurCap(proposed);
        if (base.reasoningEffort === s.lastWritten) {
          s.lastWritten = s.intent;
          base = { ...base, reasoningEffort: s.intent };
        }
      }
      const pcap = capsCfg.maxTruncations > 0 && s.truncateCount >= capsCfg.maxTruncations ? 0 : capsCfg.planningMaxTokens;
      if (pcap > 0 && base.maxTokens === void 0) {
        s.cappedThisTurn = true;
        s.lastCapWritten = pcap;
        return { ...base, maxTokens: pcap };
      }
      return base;
    }
    const routineLevel = effortCfg.routineLevel;
    const governsEffort = routineLevel !== void 0 && s.routeSupportsEffort && s.intent !== void 0;
    const governsCaps = capsCfg.mechanicalMaxTokens > 0;
    if (!governsEffort && !governsCaps) return proposed;
    if (governsEffort && effortCfg.respectExplicit && (s.explicit || agent?.options?.reasoningEffort !== void 0)) {
      if (!governsCaps) return proposed;
    }
    if (governsEffort && s.offeredEfforts === void 0 && !s.lowRejected) {
      try {
        const info = await ctx.get("llm")?.resolveModelInfo?.(proposed.provider, proposed.model, payload?.signal);
        s.offeredEfforts = info?.reasoning?.efforts?.map((e) => e.id) ?? null;
      } catch {
        s.offeredEfforts = null;
      }
      if (Array.isArray(s.offeredEfforts) && !s.offeredEfforts.includes(routineLevel)) {
        s.lowRejected = true;
        ctx.logger?.warn?.(`token-guardian: route ${proposed.provider}/${proposed.model} does not offer effort "${routineLevel}" \u2014 routine steps keep the intended level`);
      }
    }
    const breakerOpen = capsCfg.maxTruncations > 0 && s.truncateCount >= capsCfg.maxTruncations;
    const cap = breakerOpen ? 0 : capsCfg.mechanicalMaxTokens;
    let effort = s.lowRejected ? s.intent : routineLevel;
    let reason = "routine-step";
    if (s.toolError) {
      effort = s.intent;
      reason = "tool-error";
    } else if (s.repeatCount >= 2) {
      effort = s.intent;
      reason = "repeat-loop";
    } else if (s.contextWindow > 0) {
      const meter = ctx.get("tokenMeter");
      if (meter !== void 0) {
        const m = meter.measure(agent.session);
        if (m.totalTokens / s.contextWindow >= effortCfg.pressureCut) reason = "context-pressure";
      }
    }
    if (governsEffort) {
      s.lastWritten = effort;
      if (effort !== proposed.reasoningEffort) {
        ctx.logger?.info?.(`token-guardian: step ${step} ${proposed.reasoningEffort ?? "(default)"} -> ${effort} (${reason})`);
      }
    }
    if (cap > 0) {
      s.cappedThisTurn = true;
      s.lastCapWritten = cap;
      return governsEffort ? { ...proposed, reasoningEffort: effort, maxTokens: cap } : { ...proposed, maxTokens: cap };
    }
    if (!governsEffort) return proposed;
    return { ...stripOurCap(proposed), reasoningEffort: effort };
  });
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (payload?.signal?.aborted === true) return decision;
    const session = payload?.agent?.session;
    if (session === void 0) return decision;
    const s = stateOf(session);
    if (pruneEnabled) {
      try {
        const pruner = ctx.get("toolResultPruner");
        pruner?.pruneSession?.(session);
      } catch (error) {
        ctx.logger?.warn?.("token-guardian: prune failed", error);
      }
    }
    if (dedupeCfg.enabled) {
      try {
        const meter = ctx.get("tokenMeter");
        const onSurface = new Set(session.surface.nodes);
        for (const refs of s.results.values()) {
          const live = refs.filter((r) => onSurface.has(r.seq));
          for (const ref of live.slice(0, -1)) {
            const event = session.eventAt(ref.seq);
            const result = event?.data?.message?.content?.[0];
            if (event === void 0 || result === void 0 || result.isError === true || meter === void 0) continue;
            const chars = textChars(result.content ?? []);
            if (chars < dedupeCfg.minChars) continue;
            const latest = live[live.length - 1];
            const stub = `[deduped: identical call superseded by the same tool's turn-${latest.turn} step-${latest.step} result \u2014 content omitted]`;
            const message = {
              ...event.data.message,
              content: [{ ...result, content: [{ type: "text", text: stub }] }]
            };
            try {
              session.append("compaction/prune", {
                shadowedRange: { start: ref.seq, end: ref.seq },
                shadowedSeqs: [ref.seq],
                shadowedTokenCount: meter.estimateMessage(event.data.message)
              });
              session.append("tool/result", { ...event.data, message }, {
                surfaceOp: { op: "replace", startSeq: ref.seq, endSeq: ref.seq },
                sourceEventSeqs: [ref.seq]
              });
              ctx.logger?.info?.(`token-guardian: deduped result seq=${ref.seq} (-${chars} chars)`);
            } catch (error) {
              ctx.logger?.warn?.("token-guardian: dedupe failed", error);
            }
          }
        }
      } catch (error) {
        ctx.logger?.warn?.("token-guardian: dedupe scan failed", error);
      }
    }
    const distill = async (reasoningText) => {
      const llm = ctx.get("llm");
      if (llm === void 0 || s.lastProvider === void 0 || s.lastModel === void 0) return void 0;
      try {
        const parts = [];
        let failed = false;
        for await (const chunk of llm.stream({
          provider: sweepCfg.distillProvider ?? s.lastProvider,
          model: sweepCfg.distillModel ?? s.lastModel,
          reasoningEffort: "low",
          maxTokens: 1500,
          signal: payload?.signal,
          messages: [{
            id: randomUUID(),
            role: "user",
            content: [{ type: "text", text: "Distill this reasoning trace into a compact state note for your future self. Preserve: the plan and current step, decisions made and why, key facts found, open questions \u2014 anything needed to continue without re-deriving. Terse bullet points, under 200 words.\n\nREASONING:\n" + reasoningText }],
            source: { kind: "plugin", plugin: name }
          }]
        })) {
          if (chunk?.type === "text-delta") parts.push(chunk.text);
          else if (chunk?.type === "finish" && (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted")) failed = true;
        }
        const text = parts.join("").trim();
        return failed || text.length === 0 ? void 0 : text.slice(0, 4e3);
      } catch (error) {
        ctx.logger?.warn?.("token-guardian: distill call failed", error);
        return void 0;
      }
    };
    if (sweepCfg.enabled) {
      try {
        const meter = ctx.get("tokenMeter");
        if (meter !== void 0) {
          const surfaceSeqs = [...session.surface.nodes];
          const events = surfaceSeqs.map((seq) => session.eventAt(seq));
          const groups = [];
          let openIds = /* @__PURE__ */ new Set();
          let groupStart = -1;
          let foreign = false;
          const closeGroup = (endIdx) => {
            const head = events[groupStart];
            const chars = (head?.data?.message?.content ?? []).filter((b) => b?.type === "reasoning").reduce((a, b) => a + (b.text?.length ?? 0), 0);
            if (!foreign && chars >= sweepCfg.minChars) {
              groups.push({
                start: surfaceSeqs[groupStart],
                end: surfaceSeqs[endIdx],
                seqs: surfaceSeqs.slice(groupStart, endIdx + 1),
                chars,
                event: head
              });
            }
            groupStart = -1;
            foreign = false;
          };
          for (let i = 0; i < events.length; i++) {
            const event = events[i];
            if (event?.type === "assistant/message") {
              if (openIds.size > 0) {
                groupStart = -1;
                foreign = false;
              }
              const calls = (event.data?.message?.content ?? []).filter((b) => b?.type === "tool-call");
              openIds = new Set(calls.map((b) => b.id));
              groupStart = i;
              if (openIds.size === 0) closeGroup(i);
            } else if (event?.type === "tool/result") {
              const callId = event.data?.message?.source?.callId;
              if (groupStart >= 0) {
                if (callId !== void 0) openIds.delete(callId);
                if (openIds.size === 0) closeGroup(i);
              }
            } else if (groupStart >= 0) {
              foreign = true;
            }
          }
          const victims = groups.slice(0, Math.max(0, groups.length - sweepCfg.keepLatest)).filter(({ start }) => !s.swept.has(start));
          for (const { start, end, seqs, chars, event } of victims) {
            const content = event.data.message.content;
            const text = content.filter((b) => b?.type === "text").map((b) => b.text).join("").slice(0, TEXT_CAP);
            const distilled = sweepCfg.distill && chars >= 1500 ? await distill(
              content.filter((b) => b?.type === "reasoning").map((b) => typeof b.text === "string" ? b.text : "").join("\n").slice(0, sweepCfg.distillInputChars)
            ) : void 0;
            const calls = content.filter((b) => b?.type === "tool-call").map((b) => `${b.name}(${typeof b.arguments === "string" ? b.arguments.slice(0, ARGS_CAP) : ""})`);
            const results = seqs.slice(1).map((seq) => {
              const result = session.eventAt(seq);
              const block = result?.data?.message?.content?.[0];
              const preview = (Array.isArray(block?.content) ? block.content : []).map((b) => typeof b?.text === "string" ? b.text : "").join("").slice(0, sweepCfg.resultPreviewChars);
              const failed = block?.isError === true ? " ERROR" : "";
              return `${preview.length > 0 ? preview : "(no output)"}${failed}`;
            });
            const summary = [
              `[Earlier step compacted by ${name}: ${chars} reasoning chars omitted.`,
              distilled !== void 0 ? `State note:
${distilled}` : "",
              text.length > 0 ? `Assistant text: ${text}` : "",
              calls.length > 0 ? `Tool calls made: ${calls.join("; ")}` : "",
              ...results.map((r, i) => `Result ${i + 1}: ${r}`),
              "]"
            ].filter((line) => line.length > 0).join("\n");
            try {
              session.append("compaction/prune", {
                shadowedRange: { start, end },
                shadowedSeqs: seqs,
                shadowedTokenCount: seqs.reduce((total, seq) => {
                  const e = session.eventAt(seq);
                  return total + (e === void 0 ? 0 : meter.estimateMessage(e.data.message ?? e.data));
                }, 0)
              });
              session.append("user/message", {
                id: randomUUID(),
                role: "user",
                content: [{ type: "text", text: summary }],
                source: { kind: "plugin", plugin: name }
              }, {
                surfaceOp: { op: "replace", startSeq: start, endSeq: end },
                sourceEventSeqs: seqs
              });
              s.swept.add(start);
              ctx.logger?.info?.(`token-guardian: swept reasoning seqs ${start}-${end} (-${chars} chars)`);
            } catch (error) {
              ctx.logger?.warn?.("token-guardian: sweep replace failed", error);
            }
          }
        }
      } catch (error) {
        ctx.logger?.warn?.("token-guardian: sweep failed", error);
      }
    }
    if (decision?.kind !== "enter") return decision;
    const extras = [];
    try {
      if (s.shapePending) {
        s.shapePending = false;
        extras.push({
          id: randomUUID(),
          role: "user",
          content: [{ type: "text", text: shapeCfg.text }],
          source: { kind: "plugin", plugin: name }
        });
      }
      const cooling = s.lastNudgeStep >= 0 && s.stepCount - s.lastNudgeStep < loopsCfg.cooldownSteps;
      if (loopsCfg.enabled && !cooling) {
        const reasons = [];
        let loopSignal = false;
        if (loopsCfg.reasoningRepeat > 0 && s.reasoningStreak >= loopsCfg.reasoningRepeat) {
          reasons.push("reasoning-echo");
          loopSignal = true;
        }
        if (loopsCfg.sameToolStreak > 0 && s.toolStreak >= loopsCfg.sameToolStreak) {
          reasons.push(`same-tool:${s.lastToolName}`);
          loopSignal = true;
        }
        if (loopsCfg.noProgressSteps > 0 && s.stepsSinceMutation >= loopsCfg.noProgressSteps) {
          reasons.push("no-progress");
          loopSignal = true;
        }
        if (loopsCfg.turnReasoningChars > 0 && s.turnReasoningChars >= loopsCfg.turnReasoningChars) {
          reasons.push(`reasoning-budget:${s.turnReasoningChars}ch`);
        }
        if (loopsCfg.turnMinutes > 0 && s.turnStartedAt > 0 && Date.now() - s.turnStartedAt >= loopsCfg.turnMinutes * 6e4) {
          reasons.push("time-budget");
        }
        if (reasons.length > 0 && openCalls(session) === 0) {
          extras.push({
            id: randomUUID(),
            role: "user",
            content: [{ type: "text", text: DIRECTIVES[loopSignal ? Math.min(s.nudgeLevel, DIRECTIVES.length - 1) : 0] }],
            source: { kind: "plugin", plugin: name }
          });
          s.nudgeLevel++;
          s.lastNudgeStep = s.stepCount;
          s.reasoningStreak = 0;
          s.toolStreak = 0;
          s.stepsSinceMutation = 0;
          ctx.logger?.warn?.(`token-guardian: ${reasons.join("+")} -> directive level ${s.nudgeLevel}`);
        }
      }
      const batchCooling = s.batchSentAt >= 0 && (batchCfg.cooldownSteps === 0 || s.stepCount - s.batchSentAt < batchCfg.cooldownSteps);
      if (batchCfg.enabled && s.batchStreak >= batchCfg.streak && !batchCooling && openCalls(session) === 0) {
        extras.push({
          id: randomUUID(),
          role: "user",
          content: [{ type: "text", text: BATCH_HINT }],
          source: { kind: "plugin", plugin: name }
        });
        s.batchSentAt = s.stepCount;
        s.batchStreak = 0;
        ctx.logger?.info?.("token-guardian: appended batching hint");
      }
    } catch (error) {
      ctx.logger?.warn?.("token-guardian: nudge failed", error);
    }
    return extras.length === 0 ? decision : { ...decision, messages: [...decision.messages, ...extras] };
  });
}
export {
  apply,
  name
};

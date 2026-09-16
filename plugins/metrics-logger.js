import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
const name = "yuqi-metrics-logger";
const MAX_STRING = 400;
function distill(value, depth = 0) {
  if (depth > 6) return "[deep]";
  if (typeof value === "string") {
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + `\u2026[${value.length}]` : value;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, 32).map((v) => distill(v, depth + 1));
    if (value.length > 32) items.push(`\u2026[${value.length - 32} more]`);
    return items;
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = distill(v, depth + 1);
    return out;
  }
  return value;
}
function apply(ctx, config) {
  const out = config.out;
  if (out === void 0) {
    ctx.logger?.warn?.("metrics-logger: config.out is not set \u2014 logging disabled");
    return;
  }
  mkdirSync(dirname(out), { recursive: true });
  const pending = [];
  const flush = () => {
    if (pending.length === 0) return;
    try {
      appendFileSync(out, pending.join(""));
    } catch (error) {
      ctx.logger?.warn?.("metrics-logger: flush failed", error);
    }
    pending.length = 0;
  };
  ctx.on("session/event", (session, event) => {
    const row = {
      t: event?.time ?? Date.now(),
      session: session?.id,
      type: event?.type,
      seq: event?.seq,
      surfaceOp: event?.surfaceOp,
      sourceEventSeqs: event?.sourceEventSeqs,
      data: distill(event?.data ?? event?.payload ?? event)
    };
    pending.push(JSON.stringify(row) + "\n");
    if (event?.type === "turn/end" || pending.length >= 64) flush();
  });
}
export {
  apply,
  name
};

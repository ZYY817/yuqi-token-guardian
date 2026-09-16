/**
 * Session-event metrics logger. Appends one distilled JSONL row per committed
 * session event to `config.out` for offline token/effort analysis.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const name = 'yuqi-metrics-logger'

export interface Config {
  /** Output JSONL path. Required — without it the plugin warns and does nothing. */
  out?: string
}

const MAX_STRING = 400

/** Deep-clone with long strings truncated so the row stays small but parseable. */
function distill(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]'
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + `…[${value.length}]` : value
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, 32).map((v) => distill(v, depth + 1))
    if (value.length > 32) items.push(`…[${value.length - 32} more]`)
    return items
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = distill(v, depth + 1)
    return out
  }
  return value
}

export function apply(ctx: any, config: Config): void {
  const out = config.out
  if (out === undefined) {
    ctx.logger?.warn?.('metrics-logger: config.out is not set — logging disabled')
    return
  }
  mkdirSync(dirname(out), { recursive: true })
  // Buffer rows so per-event synchronous file I/O stays off the append hot
  // path; flush in batches and at turn boundaries.
  const pending: string[] = []
  const flush = (): void => {
    if (pending.length === 0) return
    try {
      appendFileSync(out, pending.join(''))
    } catch (error) {
      ctx.logger?.warn?.('metrics-logger: flush failed', error)
    }
    pending.length = 0
  }
  ctx.on('session/event', (session: any, event: any) => {
    // Keep the envelope fields: a 'replace' tool/result looks identical to an
    // append on data alone, and without surfaceOp/sourceEventSeqs offline
    // accounting double-counts shadowed and replacement nodes.
    const row: Record<string, unknown> = {
      t: event?.time ?? Date.now(),
      session: session?.id,
      type: event?.type,
      seq: event?.seq,
      surfaceOp: event?.surfaceOp,
      sourceEventSeqs: event?.sourceEventSeqs,
      data: distill(event?.data ?? event?.payload ?? event),
    }
    pending.push(JSON.stringify(row) + '\n')
    if (event?.type === 'turn/end' || pending.length >= 64) flush()
  })
}

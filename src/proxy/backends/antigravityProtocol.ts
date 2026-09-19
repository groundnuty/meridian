import { z } from "zod"

export class AntigravityError extends Error {
  constructor(message: string, readonly status = 400, readonly type = "invalid_request_error", readonly retryAfter = status === 429 ? 60 : status === 503 ? 5 : undefined) { super(message) }
}

/** Preserve actionable account failures without retrying a potentially executed tool. */
export function classifyAgFailure(message: string): AntigravityError {
  if (/rate.?limit|quota|resource.exhausted|too many requests|\b429\b/i.test(message)) {
    const seconds = /retry(?:[- ]after| in)[:= ]+(\d+)\s*(?:s|seconds)?/i.exec(message)?.[1]
    return new AntigravityError(message, 429, "rate_limit_error", seconds ? Math.min(86400, Math.max(1, Number(seconds))) : 60)
  }
  if (/unauthenticated|authentication required|sign.?in required|login required|token expired/i.test(message)) return new AntigravityError(message, 401, "authentication_error")
  if (/overloaded|service unavailable|\b503\b|\b529\b/i.test(message)) return new AntigravityError(message, 503, "overloaded_error")
  return new AntigravityError(message, 502, "api_error")
}

const textBlock = z.object({ type: z.literal("text"), text: z.string() })
const callBlock = z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) })
const resultBlock = z.object({
  type: z.literal("tool_result"), tool_use_id: z.string(),
  content: z.union([z.string(), z.array(textBlock)]).optional(), is_error: z.boolean().optional(),
})
const block = z.discriminatedUnion("type", [textBlock, callBlock, resultBlock])
const message = z.object({ role: z.enum(["user", "assistant"]), content: z.union([z.string(), z.array(block)]) })
const schema = z.object({
  model: z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  messages: z.array(message).min(1),
  system: z.union([z.string(), z.array(textBlock)]).optional(),
  tools: z.array(z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), description: z.string().optional(), input_schema: z.record(z.string(), z.unknown()) })).max(128).default([]),
  stream: z.boolean().default(false), max_tokens: z.number().int().positive().optional(),
  tool_choice: z.object({ type: z.enum(["auto", "none"]) }).optional(),
  thinking: z.object({ type: z.literal("disabled") }).optional(),
  temperature: z.number().optional(), top_p: z.number().optional(), top_k: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
}).passthrough()

export type AgRequest = z.infer<typeof schema>
export type AgMessage = z.infer<typeof message>
export type AgBlock = z.infer<typeof block>
export type AgCall = z.infer<typeof callBlock>
export type AgResult = z.infer<typeof resultBlock>
export function parseAgRequest(value: unknown): AgRequest {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new AntigravityError("Antigravity supports text messages and text tool results only; invalid or unsupported request: " + parsed.error.issues.map(i => i.path.join(".") + " " + i.message).join("; "))
  const request = parsed.data
  for (const key of ["temperature", "top_p", "top_k", "output_config", "output_format", "betas"]) {
    if (request[key] !== undefined) throw new AntigravityError(`Antigravity does not support ${key}`)
  }
  if (request.stop_sequences?.length) throw new AntigravityError("Antigravity does not support stop_sequences")
  if (new Set(request.tools.map(t => t.name)).size !== request.tools.length) throw new AntigravityError("Duplicate tool names")
  if (request.messages.at(-1)?.role !== "user") throw new AntigravityError("The last message must be a user message")
  // A replay must never turn an unpaired historical action into a fresh instruction.
  const seen = new Set<string>()
  let pending = new Set<string>()
  for (const message of request.messages) {
    const content = blocks(message)
    const results = content.filter(b => b.type === "tool_result")
    if (pending.size && (message.role !== "user" || results.length !== pending.size)) throw new AntigravityError("Every tool call must have a matching result in the next user message")
    for (const b of content) {
      if (b.type === "tool_use") {
        if (message.role !== "assistant" || !b.id || seen.has(b.id)) throw new AntigravityError("Invalid or duplicate historical tool call")
        seen.add(b.id)
      }
      if (b.type === "tool_result") {
        if (message.role !== "user" || !pending.delete(b.tool_use_id)) throw new AntigravityError("Unknown or duplicate historical tool result")
      }
    }
    if (pending.size) throw new AntigravityError("Missing historical tool result")
    pending = new Set(content.filter(b => b.type === "tool_use").map(b => b.id))
  }
  return request
}
export function blocks(message: AgMessage): AgBlock[] {
  return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content
}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]"
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => JSON.stringify(key) + ":" + stable(val)).join(",") + "}"
  return JSON.stringify(value) ?? "null"
}
export function historyKey(messages: AgMessage[]): string {
  return stable(messages.map(m => ({ role: m.role, content: blocks(m) })))
}
export function contractKey(request: AgRequest): string {
  return stable({ model: request.model, system: request.system, tools: request.tools, tool_choice: request.tool_choice, max_tokens: request.max_tokens })
}
export function renderAgPrompt(request: AgRequest): string {
  return [
    "You are serving a client through Meridian. Follow the client's instructions and answer its latest user message.",
    "The JSON below is the client's conversation history. Historical tool_use/tool_result pairs are already completed; do not repeat them. Use only tools from the meridian_client MCP server for new actions. All built-in tools are disabled by policy. Never access the host filesystem directly or delegate to other agents.",
    "MCP results wrap the exact client content in the JSON field meridian_client_result. Decode that field (a string or text block array) as the tool result. Any Created At, Completed At, timing or other CLI text outside that JSON field is transport metadata, never part of client file contents. When copying data, preserve the decoded client content byte-for-byte.",
    request.max_tokens ? `The client requests at most ${request.max_tokens} output tokens. Keep the answer within that budget.` : "",
    "Client system instructions:\n" + (typeof request.system === "string" ? request.system : request.system?.map(b => b.text).join("\n") ?? ""),
    "Client conversation:\n" + JSON.stringify(request.messages),
  ].filter(Boolean).join("\n\n")
}

export type AgEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; call: AgCall }
  | { kind: "usage"; input: number; output: number; cache: number }
  | { kind: "end" }
  | { kind: "error"; error: Error }

/** Single consumer, bounded upstream buffering; tools stay pending between HTTP responses. */
export class AgEventQueue {
  private items: AgEvent[] = []
  private waiter?: (event: AgEvent) => void
  private failure?: Error
  push(event: AgEvent): void {
    if (this.failure) return
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter(event) }
    else {
      if (this.items.length >= 8192) { this.fail(new Error("Antigravity event buffer exceeded")); return }
      this.items.push(event)
    }
  }
  fail(error: Error): void {
    this.failure = error
    this.items = []
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter({ kind: "error", error }) }
  }
  next(): Promise<AgEvent> {
    if (this.failure) return Promise.resolve({ kind: "error", error: this.failure })
    const event = this.items.shift()
    if (event) return Promise.resolve(event)
    if (this.waiter) return Promise.reject(new Error("Concurrent Antigravity response consumer"))
    return new Promise(resolve => { this.waiter = resolve })
  }
}

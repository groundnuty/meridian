import { randomUUID } from "node:crypto"
import type { ProxyConfig, ProxyServer } from "../types"
import { getBuildInfo } from "../buildInfo"
import { hasValidApiKey } from "../auth"
import { AntigravityRuntime, type AntigravityRun } from "./antigravityRuntime"
import { AntigravityError, blocks, contractKey, historyKey, parseAgRequest, type AgBlock, type AgRequest } from "./antigravityProtocol"

function errorResponse(error: unknown): Response {
  const e = error instanceof AntigravityError ? error : new AntigravityError(error instanceof Error ? error.message : String(error), 503, "api_error")
  return Response.json({ type: "error", error: { type: e.type, message: e.message } }, { status: e.status, headers: e.status === 429 || e.status === 503 ? { "retry-after": "5" } : {} })
}
async function readBody(request: Request): Promise<unknown> {
  if (!request.body) throw new AntigravityError("Missing request body")
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []; let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break
      length += value.length
      if (length > 8 * 1024 * 1024) { await reader.cancel(); throw new AntigravityError("Request exceeds 8 MiB", 413) }
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch (error) {
    if (error instanceof AntigravityError) throw error
    throw new AntigravityError("Invalid JSON request body")
  } finally { reader.releaseLock() }
}

export function createAntigravityServer(config: ProxyConfig, runtime = new AntigravityRuntime({ ...config.antigravity, maxConcurrent: config.antigravity?.maxConcurrent ?? config.maxConcurrent })): ProxyServer & { closeBackend(): Promise<void> } {
  if (config.profiles?.length || config.defaultProfile) throw new Error("Antigravity does not support Claude profile configuration")
  async function selectRun(body: AgRequest): Promise<AntigravityRun> {
    const last = blocks(body.messages.at(-1)!)
    const results = last.filter(b => b.type === "tool_result")
    if (results.length) {
      if (results.length !== 1 || last.length !== 1) throw new AntigravityError("Antigravity requires one requested tool result per continuation, without additional user content", 409)
      const result = results[0]!
      const run = runtime.toolOwners.get(result.tool_use_id)
      if (!run) throw new AntigravityError("Antigravity tool turn expired or was interrupted; start a new user turn with the complete completed-tool history", 409)
      if (run.busy) throw new AntigravityError("Antigravity turn already has an active response", 409)
      if (run.delivered?.id !== result.tool_use_id || run.contract !== contractKey(body) || historyKey(run.history) !== historyKey(body.messages.slice(0, -1))) {
        throw new AntigravityError("Pending Antigravity tool continuation changed its history, model, instructions or tools", 409)
      }
      run.busy = true
      run.history = body.messages
      run.accept(result)
      return run
    }
    const run = await runtime.create(body)
    run.busy = true
    return run
  }

  async function messages(request: Request): Promise<Response> {
    if (runtime.draining) throw new AntigravityError("Antigravity is shutting down", 503, "api_error")
    if (request.headers.has("x-meridian-profile")) throw new AntigravityError("Antigravity uses the current agy account; Claude profile routing is unavailable")
    const body = parseAgRequest(await readBody(request))
    if (request.signal.aborted) throw new AntigravityError("Request cancelled", 499, "api_error")
    const run = await selectRun(body)
    const cancel = () => run.abort(new AntigravityError("Request cancelled", 499, "api_error"))
    request.signal.addEventListener("abort", cancel, { once: true })
    if (request.signal.aborted) cancel()
    const id = "msg_agy_" + randomUUID().replaceAll("-", "")
    async function consume(emit?: (event: string, value: unknown) => void) {
      const content: AgBlock[] = []
      const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      let textOpen = false
      let reason: "end_turn" | "tool_use" = "end_turn"
      const base = { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage } }
      emit?.("message_start", { type: "message_start", message: base })
      try {
        while (true) {
          const event = await run.queue.next()
          if (event.kind === "error") throw event.error
          if (event.kind === "usage") { usage.input_tokens += event.input; usage.output_tokens += event.output; usage.cache_read_input_tokens += event.cache; continue }
          if (event.kind === "text") {
            if (!textOpen) {
              content.push({ type: "text", text: "" }); textOpen = true
              emit?.("content_block_start", { type: "content_block_start", index: content.length - 1, content_block: { type: "text", text: "" } })
            }
            const tail = content.at(-1)
            if (tail?.type === "text") tail.text += event.text
            emit?.("content_block_delta", { type: "content_block_delta", index: content.length - 1, delta: { type: "text_delta", text: event.text } })
            continue
          }
          if (textOpen) { emit?.("content_block_stop", { type: "content_block_stop", index: content.length - 1 }); textOpen = false }
          if (event.kind === "tool") {
            content.push(event.call)
            const index = content.length - 1
            emit?.("content_block_start", { type: "content_block_start", index, content_block: { ...event.call, input: {} } })
            emit?.("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(event.call.input) } })
            emit?.("content_block_stop", { type: "content_block_stop", index })
            run.markDelivered(event.call)
            run.history = [...run.history, { role: "assistant", content }]
            reason = "tool_use"
          }
          break
        }
        emit?.("message_delta", { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage })
        emit?.("message_stop", { type: "message_stop" })
        return { ...base, content, stop_reason: reason, usage }
      } catch (error) {
        run.abort(error instanceof Error ? error : new Error(String(error)))
        throw error
      } finally {
        run.busy = false
        request.signal.removeEventListener("abort", cancel)
      }
    }
    if (!body.stream) return Response.json(await consume())
    let cancelled = false
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (event: string, value: unknown) => { if (!cancelled) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)) }
        const heartbeat = setInterval(() => emit("ping", { type: "ping" }), 10000)
        heartbeat.unref()
        void consume(emit).catch(error => {
          emit("error", { type: "error", error: { type: error instanceof AntigravityError ? error.type : "api_error", message: String(error instanceof Error ? error.message : error) } })
        }).finally(() => { clearInterval(heartbeat); if (!cancelled) controller.close() })
      },
      cancel() { cancelled = true; cancel() },
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } })
  }

  const fetch = async (request: Request): Promise<Response> => {
    try {
      const path = new URL(request.url).pathname
      if (!["/health", "/readyz", "/livez"].includes(path) && !hasValidApiKey(request.headers)) throw new AntigravityError("Invalid or missing API key", 401, "authentication_error")
      if (request.method === "GET" && path === "/livez") return Response.json({ status: "alive" })
      if (request.method === "GET" && ["/health", "/readyz"].includes(path)) {
        if (runtime.draining) return Response.json({ status: "draining" }, { status: 503 })
        await runtime.availableModels()
        return Response.json({ status: "healthy", version: config.version ?? "unknown", build: getBuildInfo({ version: config.version ?? "unknown", modulePath: import.meta.url }), backend: "antigravity", experimental: true, mode: "passthrough", auth: { loggedIn: true, provider: "agy-account" }, capabilities: { text: true, tools: !!runtime.options.allowToolBridge, images: false, persistentResume: false, maxTokens: "advisory" }, processes: runtime.runs.size })
      }
      if (request.method === "GET" && path === "/v1/models") {
        const models = await runtime.availableModels()
        return Response.json({ object: "list", data: models.map(id => ({ id, type: "model", object: "model", display_name: id, owned_by: "antigravity" })), has_more: false, first_id: models[0], last_id: models.at(-1) })
      }
      if (request.method === "POST" && ["/v1/messages", "/messages"].includes(path)) return await messages(request)
      return errorResponse(new AntigravityError("Endpoint unavailable on the experimental Antigravity backend", 404, "not_found_error"))
    } catch (error) { return errorResponse(error) }
  }
  return {
    app: { fetch }, config,
    initPlugins: () => runtime.initialize(),
    beginDrain: () => { runtime.draining = true },
    forceAbortInFlight: () => { for (const run of runtime.runs.values()) run.abort(new Error("Backend shutting down")) },
    getInFlightCount: () => runtime.runs.size,
    closeBackend: () => runtime.close(),
  }
}

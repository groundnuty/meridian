import { afterEach, describe, expect, it } from "bun:test"
import { fileURLToPath } from "node:url"
import { createAntigravityServer } from "../proxy/backends/antigravity"
import { AntigravityRuntime } from "../proxy/backends/antigravityRuntime"
import { DEFAULT_PROXY_CONFIG } from "../proxy/types"
import { parseAgRequest, historyKey } from "../proxy/backends/antigravityProtocol"

interface TestReply {
  backend?: string
  stop_reason: string
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number }
}
async function decode(response: Response): Promise<TestReply> { return await response.json() as TestReply }

const executable = fileURLToPath(new URL("./fixtures/agy-cli.cjs", import.meta.url))
const closing: Array<() => Promise<void>> = []
function fixture(options = {}) {
  const runtime = new AntigravityRuntime({ executable, allowToolBridge: true, turnTimeoutMs: 10000, ...options })
  const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity" }, runtime)
  closing.push(server.closeBackend)
  const send = (body: unknown, signal?: AbortSignal) => server.app.fetch(new Request("http://local/v1/messages", { method: "POST", body: JSON.stringify(body), signal }))
  return { runtime, server, send }
}
const tool = { name: "lookup", input_schema: { type: "object", properties: { key: { type: "string" } } } }
const initial = (content = "Get receipt") => ({ model: "fixture-model", max_tokens: 100, messages: [{ role: "user", content }], tools: [tool] })
afterEach(async () => { for (const close of closing.splice(0)) await close() })

describe("Antigravity request contract", () => {
  it("rejects images and unsupported controls before creating a process", () => {
    expect(() => parseAgRequest({ ...initial(), messages: [{ role: "user", content: [{ type: "image", source: {} }] }] })).toThrow("text")
    expect(() => parseAgRequest({ ...initial(), temperature: 0 })).toThrow("temperature")
    expect(() => parseAgRequest({ ...initial(), thinking: { type: "enabled", budget_tokens: 100 } })).toThrow()
    expect(() => parseAgRequest({ ...initial(), tool_choice: { type: "tool", name: "lookup" } })).toThrow()
  })
  it("normalizes string/text messages and JSON key order for continuation", () => {
    expect(historyKey([{ role: "user", content: "hello" }])).toBe(historyKey([{ role: "user", content: [{ type: "text", text: "hello" }] }]))
  })
})

describe.skipIf(process.platform === "win32")("Antigravity HTTP/CLI integration", () => {
  it("returns model discovery, health, text and per-invocation usage", async () => {
    const { server, send } = fixture()
    const health = await server.app.fetch(new Request("http://local/health"))
    expect((await decode(health)).backend).toBe("antigravity")
    const response = await send({ ...initial("Hello"), tools: [] })
    expect(response.status).toBe(200)
    const body = await decode(response)
    expect(body.content).toEqual([{ type: "text", text: "READY" }])
    expect(body.usage.input_tokens).toBe(100) // CLI input includes its 20 cached tokens.
    expect(body.usage.cache_read_input_tokens).toBe(20)
  })
  it("holds MCP until the matching HTTP tool result and preserves is_error", async () => {
    const { send, runtime } = fixture()
    const request = initial()
    const first = await decode(await send(request))
    expect(first.stop_reason).toBe("tool_use")
    expect(runtime.runs.size).toBe(1)
    const call = first.content.find((b: { type: string }) => b.type === "tool_use")!
    const followup = { ...request, messages: [...request.messages, { role: "assistant", content: first.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "client-secret", is_error: true }] }] }
    const changed = { ...followup, model: "other-model" }
    expect((await send(changed)).status).toBe(409)
    const answer = await decode(await send(followup))
    expect(answer.content[0]!.text).toBe("FAILED:client-secret")
    expect(answer.usage.input_tokens).toBe(100) // Not the earlier 100-token tool request.
    expect((await send(followup)).status).toBe(409) // No duplicate execution.
  })
  it("preserves UTF-8 tool arguments split across MCP network chunks", async () => {
    const { send } = fixture()
    const request = initial("UNICODE_CHUNKS")
    const first = await decode(await send(request))
    const call = first.content.find(b => b.type === "tool_use")!
    expect(call.input).toEqual({ key: "café/你好/🧪.txt" })
    const response = await send({ ...request, messages: [...request.messages, { role: "assistant", content: first.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "done" }] }] })
    expect((await decode(response)).content[0]?.text).toBe("UNICODE_OK")
  })
  it("serializes a parallel upstream batch into individually correlated client calls", async () => {
    const { send } = fixture()
    const request = initial("PARALLEL2")
    let messages: unknown[] = request.messages
    for (let i = 0; i < 2; i++) {
      const response = await decode(await send({ ...request, messages }))
      expect(response.stop_reason).toBe("tool_use")
      const call = response.content.find((b: { type: string }) => b.type === "tool_use")!
      messages = [...messages, { role: "assistant", content: response.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: `value${i}` }] }]
    }
    const answer = await decode(await send({ ...request, messages }))
    expect(answer.content[0]!.text).toBe("value0|value1")
  })
  it("emits complete SSE blocks, usage, and stop events", async () => {
    const { send } = fixture()
    const response = await send({ ...initial(), tools: [], stream: true })
    const events = (await response.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)))
    expect(events.map(e => e.type)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"])
    expect(events[2].delta.text).toBe("READY")
    expect(events[4].usage.output_tokens).toBe(10)
  })
  it("does not report denied actions as a successful response", async () => {
    const { send } = fixture()
    expect((await send({ ...initial("DENIED"), tools: [] })).status).toBe(502)
    const response = await send({ ...initial("DENIED"), tools: [], stream: true })
    const sse = await response.text()
    expect(sse).toContain("event: error")
    expect(sse).not.toContain("event: message_stop")
  })
  it("bounds pending tool lifetime and rejects stale results", async () => {
    const { send, runtime } = fixture({ pendingToolTimeoutMs: 40 })
    const request = initial()
    const first = await decode(await send(request))
    const run = [...runtime.runs.values()][0]!
    await run.settled
    expect(runtime.runs.size).toBe(0)
    expect((await send({ ...request, messages: [...request.messages, { role: "assistant", content: first.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: first.content[0]!.id, content: "late" }] }] })).status).toBe(409)
  })
  it("counts pending tools toward capacity and drains all processes", async () => {
    const { send, server, runtime } = fixture({ maxConcurrent: 1 })
    await send(initial())
    const overloaded = await send(initial())
    expect(overloaded.status).toBe(429)
    expect(overloaded.headers.get("retry-after")).toBe("5")
    server.beginDrain?.()
    expect((await send(initial())).status).toBe(503)
    await runtime.close()
    expect(runtime.runs.size).toBe(0)
  })
  it("times out a stalled CLI and releases its process", async () => {
    const { send, runtime } = fixture({ turnTimeoutMs: 100 })
    const response = await send({ ...initial("HANG"), tools: [] })
    expect(response.status).toBe(504)
    await Promise.all([...runtime.runs.values()].map(run => run.settled))
    expect(runtime.runs.size).toBe(0)
  })
  it("rejects malformed CLI output instead of emitting success", async () => {
    const { send } = fixture()
    expect((await send({ ...initial("MALFORMED"), tools: [] })).status).toBe(502)
  })
  it("requires the explicit tool-bridge opt-in", async () => {
    const { send, runtime } = fixture({ allowToolBridge: false })
    expect((await send(initial())).status).toBe(400)
    expect(runtime.runs.size).toBe(0)
  })
  it("refuses an API-key provider instead of silently bypassing the account", async () => {
    const { server, runtime } = fixture()
    runtime.childEnv.AGY_FIXTURE_API = "1"
    const response = await server.app.fetch(new Request("http://local/health"))
    expect(response.status).toBe(503)
    expect(await response.text()).toContain("default account authentication")
    expect(runtime.runs.size).toBe(0)
  })
  it("recovers an embedded server after account configuration is corrected", async () => {
    const { send, runtime } = fixture()
    runtime.childEnv.AGY_FIXTURE_API = "1"
    expect((await send({ ...initial(), tools: [] })).status).toBe(503)
    delete runtime.childEnv.AGY_FIXTURE_API
    expect((await send({ ...initial(), tools: [] })).status).toBe(200)
  })
  it("cancels the subprocess when a streaming reader disconnects", async () => {
    const { send, runtime } = fixture()
    const response = await send({ ...initial("HANG"), tools: [], stream: true })
    const run = [...runtime.runs.values()][0]!
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()
    await run.settled
    expect(runtime.runs.size).toBe(0)
  })
  it("sends long conversation history on stdin instead of exceeding argv limits", async () => {
    const { send } = fixture()
    expect((await send({ ...initial("a".repeat(200000)), tools: [] })).status).toBe(200)
  })
  it("honors Meridian API keys while keeping health probes public", async () => {
    const previous = process.env.MERIDIAN_API_KEY
    process.env.MERIDIAN_API_KEY = "fixture-access"
    try {
      const { server, send } = fixture()
      expect((await send(initial())).status).toBe(401)
      expect((await server.app.fetch(new Request("http://local/health"))).status).toBe(200)
      expect((await server.app.fetch(new Request("http://local/v1/models", { headers: { authorization: "Bearer fixture-access" } }))).status).toBe(200)
    } finally {
      if (previous === undefined) delete process.env.MERIDIAN_API_KEY
      else process.env.MERIDIAN_API_KEY = previous
    }
  })
  it("refuses unverified CLI upgrades and changed provider settings before a fresh process", async () => {
    const { send, runtime } = fixture()
    expect((await send({ ...initial(), tools: [] })).status).toBe(200)
    runtime.childEnv.AGY_FIXTURE_API = "1"
    expect((await send({ ...initial(), tools: [] })).status).toBe(503)
    delete runtime.childEnv.AGY_FIXTURE_API
    runtime.childEnv.AGY_FIXTURE_VERSION = "2.0.0"
    const response = await send({ ...initial(), tools: [] })
    expect(response.status).toBe(503)
    expect(await response.text()).toContain("Unsupported agy version")
  })
  it("classifies quota refusals consistently for JSON and SSE", async () => {
    const { send } = fixture()
    const response = await send({ ...initial("RATE_LIMIT"), tools: [] })
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("45")
    const stream = await (await send({ ...initial("RATE_LIMIT"), tools: [], stream: true })).text()
    expect(stream).toContain('"retry_after":45')
    expect(stream).not.toContain("event: message_stop")
  })
  it("does not commit success before a clean CLI exit", async () => {
    const { send } = fixture({ turnTimeoutMs: 200 })
    expect((await send({ ...initial("BAD_EXIT"), tools: [] })).status).toBe(502)
    expect((await send({ ...initial("LINGER"), tools: [] })).status).toBe(504)
  })
  it("bounds simultaneous preflight admission and cancels initialization on shutdown", async () => {
    const { send, runtime } = fixture({ maxConcurrent: 1 })
    const first = send({ ...initial("HANG"), tools: [] })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect((await send(initial())).status).toBe(429)
    await runtime.close()
    expect((await first).status).toBe(503)
    expect(runtime.preparing).toBe(0)
    expect(runtime.runs.size).toBe(0)
  })
  it("exposes real CLI quota groups separately from observed tokens", async () => {
    const { server, send, runtime } = fixture()
    await send({ ...initial(), tools: [] })
    await runtime.accountQuota()
    const response = await server.app.fetch(new Request("http://local/providers/status"))
    const body = await response.json() as { providers: Array<{ id: string; activity?: { requests: number }; accounts: Array<{ windows: Array<{ utilization: number; group: string }> }> }> }
    const provider = body.providers.find(p => p.id === "antigravity")!
    expect(provider.activity?.requests).toBe(1)
    expect(provider.accounts[0]!.windows[0]).toMatchObject({ group: "Gemini Models", utilization: 0.25 })
    const page = await server.app.fetch(new Request("http://local/providers/view?provider=antigravity"))
    expect(await page.text()).toContain('data-provider-card="antigravity"')
  })

  it("runs the generated policy and permits only declared client MCP calls", async () => {
    const { send } = fixture()
    const response = await send(initial("POLICY_PROBE"))
    expect(response.status).toBe(200)
    expect((await decode(response)).stop_reason).toBe("tool_use")
  })

  it("bounds activity to the past hour independently of the request-history ring", () => {
    const { runtime } = fixture()
    const base = { requestId: "activity", durationMs: 1, model: "fixture", status: 200, inputTokens: 2, outputTokens: 3, cacheReadTokens: 0 }
    runtime.record({ ...base, timestamp: Date.now() - 7200000 })
    for (let n = 0; n < 600; n++) runtime.record({ ...base, timestamp: Date.now() })
    expect(runtime.requests.length).toBe(500)
    expect(runtime.activity()).toMatchObject({requests:600,inputTokens:1200,outputTokens:1800})
    expect(runtime.totals.requests).toBe(601)
  })

  it("does not deliver a second client tool when the CLI retries its MCP request", async () => {
    const { send } = fixture()
    const request = initial("RPC_RETRY")
    const first = await decode(await send(request))
    const call = first.content.find(b => b.type === 'tool_use')!
    const answer = await decode(await send({...request,messages:[...request.messages,{role:'assistant',content:first.content},{role:'user',content:[{type:'tool_result',tool_use_id:call.id,content:'once'}]}]}))
    expect(answer.stop_reason).toBe('end_turn')
    expect(answer.content[0]?.text).toBe('once|once')
  })

  it("returns provider navigation without waiting for CLI quota and joins its probes on close", async () => {
    const { server, runtime } = fixture()
    const before = Date.now()
    const response = await server.app.fetch(new Request('http://local/providers/status'))
    expect(response.status).toBe(200)
    expect(Date.now() - before).toBeLessThan(500)
    await runtime.close()
    expect(runtime.runs.size).toBe(0)
  })

})

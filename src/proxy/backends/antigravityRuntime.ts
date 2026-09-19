import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process"
import { promisify } from "node:util"
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http"
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import { z } from "zod"
import { AgEventQueue, AntigravityError, renderAgPrompt, contractKey, type AgRequest, type AgMessage, type AgCall, type AgResult } from "./antigravityProtocol"

import type { AntigravityOptions } from "../types"
const exec = promisify(execFile)
const envelope = z.object({
  event: z.string(),
  step_update: z.object({ step_type: z.string().optional(), state: z.string().optional(), text_delta: z.string().optional(), usage: z.object({ input_tokens: z.number().optional(), output_tokens: z.number().optional(), cache_read_tokens: z.number().optional() }).optional() }).optional(),
  result: z.object({ status: z.string(), error: z.string().optional(), denied_actions: z.array(z.unknown()).optional() }).optional(),
})
const rpcSchema = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]).optional(), method: z.string(), params: z.record(z.string(), z.unknown()).optional() })
const toolParams = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) })

function reply(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value))
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

export class AntigravityRun {
  readonly id = randomUUID()
  readonly queue = new AgEventQueue()
  readonly contract: string
  history: AgMessage[]
  busy = false
  delivered?: AgCall
  child?: ChildProcessWithoutNullStreams
  private workspace?: string
  private stopped = false
  private terminal = false
  private timer?: ReturnType<typeof setTimeout>
  private pendingTimer?: ReturnType<typeof setTimeout>
  private killTimer?: ReturnType<typeof setTimeout>
  private readonly pending = new Map<string, { call: AgCall; resolve: (result: AgResult) => void; reject: (error: Error) => void }>()
  private settledResolve!: () => void
  readonly settled = new Promise<void>(resolve => { this.settledResolve = resolve })
  constructor(readonly runtime: AntigravityRuntime, readonly request: AgRequest) {
    this.history = request.messages
    this.contract = contractKey(request)
  }
  async start(): Promise<void> {
    try {
      this.workspace = await realpath(await mkdtemp(join(tmpdir(), "meridian-agy-")))
      await mkdir(join(this.workspace, ".agents"))
      const tools = this.request.tool_choice?.type === "none" ? [] : this.request.tools
      const hookPath = join(this.workspace, "policy.cjs")
      // Agent-visible workspace contains no client files. The only allowed action
      // is the synthetic MCP server dispatch; the host never executes client tools.
      await writeFile(hookPath, `let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{try{const p=JSON.parse(input);const t=p.toolCall;const a=t?.args;const allowed=t?.name==='call_mcp_tool'&&a?.ServerName==='meridian_client'&&${JSON.stringify(tools.map(t => t.name))}.includes(a?.ToolName);console.log(JSON.stringify({decision:allowed?'allow':'deny',reason:'Meridian allows only client-owned MCP tools'}));}catch(e){console.error(String(e));process.exitCode=1;}});`)
      await writeFile(join(this.workspace, ".agents/hooks.json"), JSON.stringify({ meridian_policy: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `${quote(process.execPath)} ${quote(hookPath)}`, timeout: 5 }] }] } }))
      await writeFile(join(this.workspace, ".agents/mcp_config.json"), JSON.stringify({ mcpServers: { meridian_client: { serverUrl: `${this.runtime.mcpUrl}/${this.id}` } } }))
      if (this.stopped) { await this.cleanup(); return }
      const args = ["--new-project", "--add-dir", this.workspace, "--input-format", "stream-json", "--model", this.request.model, "--output-format", "stream-json", "--print-timeout", `${Math.ceil(this.runtime.turnTimeoutMs / 1000)}s`, "--disable-slash-commands"]
      if (tools.length) args.push("--dangerously-skip-permissions")
      const child = this.child = spawn(this.runtime.executable, args, { cwd: this.workspace, env: this.runtime.childEnv, stdio: ["pipe", "pipe", "pipe"], detached: true })
      child.stdin.on("error", error => this.abort(new AntigravityError(`Antigravity input failed: ${error.message}`, 502, "api_error")))
      child.stdin.end(JSON.stringify({ event: "user", message: { content: renderAgPrompt(this.request) } }) + "\n")
      let stderr = "", bytes = 0
      child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-8192) })
      child.stdout.on("data", chunk => {
        bytes += chunk.length
        if (bytes > 16 * 1024 * 1024) this.abort(new AntigravityError("Antigravity output exceeded 16 MiB", 502, "api_error"))
      })
      const lines = createInterface({ input: child.stdout })
      lines.on("line", line => {
        if (this.stopped) return
        try {
          const event = envelope.parse(JSON.parse(line))
          const step = event.step_update
          if (step?.step_type === "agent_response" && step.text_delta) this.queue.push({ kind: "text", text: step.text_delta })
          if (step?.state === "DONE" && step.usage) this.queue.push({ kind: "usage", input: step.usage.input_tokens ?? 0, output: step.usage.output_tokens ?? 0, cache: step.usage.cache_read_tokens ?? 0 })
          if (event.event === "result" && event.result) {
            this.terminal = true
            if (event.result.status !== "SUCCESS" || event.result.denied_actions?.length) {
              this.abort(new AntigravityError(event.result.error || "Antigravity denied an action; client-owned tool policy or account permission prevented completion", 502, "api_error"))
            } else if (this.pending.size) this.abort(new AntigravityError("Antigravity ended with unresolved client tools", 502, "api_error"))
            else this.queue.push({ kind: "end" })
          }
        } catch (error) { this.abort(new AntigravityError(`Invalid Antigravity stream: ${String(error)}`, 502, "api_error")) }
      })
      child.once("error", error => this.abort(new AntigravityError(`Cannot start agy: ${error.message}`, 503, "api_error")))
      child.once("close", () => {
        if (!this.terminal && !this.stopped) this.abort(new AntigravityError(`Antigravity exited without a result${stderr ? ": " + stderr.slice(-1000) : ""}`, 502, "api_error"))
        void this.cleanup()
      })
      this.timer = setTimeout(() => this.abort(new AntigravityError("Antigravity turn timed out", 504, "api_error")), this.runtime.turnTimeoutMs)
      this.timer.unref()
    } catch (error) {
      this.abort(error instanceof Error ? error : new Error(String(error)))
      await this.cleanup()
      throw error
    }
  }
  async call(name: string, input: Record<string, unknown>): Promise<AgResult> {
    if (this.stopped || this.terminal) throw new Error("Turn is closed")
    if (this.pending.size >= 32) throw new Error("Too many outstanding tools")
    const call: AgCall = { type: "tool_use", id: "toolu_agy_" + randomUUID().replaceAll("-", ""), name, input }
    return new Promise((resolve, reject) => {
      this.pending.set(call.id, { call, resolve, reject })
      this.runtime.toolOwners.set(call.id, this)
      this.queue.push({ kind: "tool", call })
    })
  }
  markDelivered(call: AgCall): void {
    this.delivered = call
    this.pendingTimer = setTimeout(() => this.abort(new AntigravityError("Client tool result deadline expired; start a fresh turn", 409, "invalid_request_error")), this.runtime.pendingToolTimeoutMs)
    this.pendingTimer.unref()
  }
  accept(result: AgResult): void {
    const pending = this.pending.get(result.tool_use_id)
    if (!pending || result.tool_use_id !== this.delivered?.id) throw new AntigravityError("Tool result was not requested by this turn", 409)
    clearTimeout(this.pendingTimer)
    this.pending.delete(result.tool_use_id)
    this.runtime.toolOwners.delete(result.tool_use_id)
    this.delivered = undefined
    pending.resolve(result)
  }
  abort(error: Error): void {
    if (this.stopped) return
    this.stopped = true
    this.queue.fail(error)
    for (const [id, pending] of this.pending) { this.runtime.toolOwners.delete(id); pending.reject(error) }
    this.pending.clear()
    clearTimeout(this.timer); clearTimeout(this.pendingTimer)
    if (this.child?.pid) {
      this.signal("SIGTERM")
      this.killTimer = setTimeout(() => this.signal("SIGKILL"), 1000)
      this.killTimer.unref()
    }
  }
  private signal(signal: NodeJS.Signals): void {
    if (!this.child?.pid) return
    try { process.kill(-this.child.pid, signal) }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) this.child.kill(signal) }
  }
  private async cleanup(): Promise<void> {
    clearTimeout(this.timer); clearTimeout(this.pendingTimer); clearTimeout(this.killTimer)
    this.runtime.runs.delete(this.id)
    try { if (this.workspace) await rm(this.workspace, { recursive: true, force: true }) }
    catch (error) { console.error("[antigravity] Temporary workspace cleanup failed:", String(error)) }
    this.settledResolve()
  }
}

export class AntigravityRuntime {
  readonly executable: string
  readonly turnTimeoutMs: number
  readonly pendingToolTimeoutMs: number
  readonly maxConcurrent: number
  readonly childEnv: NodeJS.ProcessEnv
  // Live requests, not a durable session cache. Completed turns replay client history.
  readonly runs = new Map<string, AntigravityRun>()
  readonly toolOwners = new Map<string, AntigravityRun>()
  mcpUrl = ""
  draining = false
  private server?: Server
  private initialization?: Promise<void>
  private models: string[] = []
  private checkedAt = 0
  private checking?: Promise<string[]>
  private closing?: Promise<void>
  constructor(readonly options: AntigravityOptions = {}) {
    this.executable = options.executable ?? "agy"
    this.maxConcurrent = options.maxConcurrent ?? 4
    this.turnTimeoutMs = options.turnTimeoutMs ?? 300_000
    this.pendingToolTimeoutMs = options.pendingToolTimeoutMs ?? 60_000
    for (const value of [this.maxConcurrent, this.turnTimeoutMs, this.pendingToolTimeoutMs]) if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Antigravity limits must be positive integers")
    this.childEnv = { ...process.env }
    for (const key of Object.keys(this.childEnv)) if (/^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_GENAI_USE_.*|GOOGLE_GEMINI_BASE_URL|ANTHROPIC_.*|MERIDIAN_API_KEY)$/.test(key)) delete this.childEnv[key]
  }
  async availableModels(): Promise<string[]> {
    if (Date.now() - this.checkedAt < 60_000) return this.models
    this.checking ??= (async () => {
      if (process.platform === "win32") throw new Error("Experimental Antigravity backend currently supports macOS and Linux only")
      const opts = { env: this.childEnv, timeout: 20_000, maxBuffer: 1024 * 1024 }
      const config = await exec(this.executable, ["-p", "/config", "--output-format", "json"], opts)
      const settings = z.object({ command: z.object({ data: z.object({ config: z.object({ modelProvider: z.unknown().optional(), useG1Credits: z.unknown().optional(), gcp: z.unknown().optional() }) }) }) }).parse(JSON.parse(config.stdout)).command.data.config
      if (settings.modelProvider || settings.useG1Credits || settings.gcp) throw new Error("Antigravity requires default account authentication with paid overage credits disabled; configure agy first")
      const result = await exec(this.executable, ["models"], opts)
      const models = result.stdout.split("\n").filter(line => line.includes("\t")).map(line => line.split("\t")[0]!).filter(Boolean)
      if (!models.length) throw new Error("No account models available; sign in using agy")
      this.models = models; this.checkedAt = Date.now(); return models
    })().finally(() => { this.checking = undefined })
    return this.checking
  }
  async initialize(): Promise<void> {
    this.initialization ??= (async () => {
      await this.availableModels()
      if (this.draining) throw new Error("Antigravity is shutting down")
      this.server = createServer((req, res) => { void this.handleMcp(req, res) })
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject)
        this.server!.listen(0, "127.0.0.1", resolve)
      })
      const address = this.server.address()
      if (!address || typeof address === "string") throw new Error("Cannot bind MCP listener")
      this.mcpUrl = `http://127.0.0.1:${address.port}`
    })().catch(error => { this.initialization = undefined; throw error })
    return this.initialization
  }
  async create(request: AgRequest): Promise<AntigravityRun> {
    await this.initialize()
    if (this.draining) throw new AntigravityError("Antigravity is shutting down", 503, "api_error")
    if (!(await this.availableModels()).includes(request.model)) throw new AntigravityError("Unknown Antigravity model; use GET /v1/models for account model slugs")
    if (this.draining) throw new AntigravityError("Antigravity is shutting down", 503, "api_error")
    if (request.tools.length && request.tool_choice?.type !== "none" && !this.options.allowToolBridge) throw new AntigravityError("Client tools require explicit MERIDIAN_AGY_ALLOW_TOOL_BRIDGE=1; see the experimental Antigravity guide")
    if (this.runs.size >= this.maxConcurrent) throw new AntigravityError("Antigravity process capacity is full; pending client tools count toward capacity", 429, "rate_limit_error")
    const run = new AntigravityRun(this, request)
    this.runs.set(run.id, run)
    await run.start()
    return run
  }
  private async handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let rpcId: string | number | undefined
    try {
      const run = this.runs.get((req.url ?? "").slice(1))
      if (!run) return reply(res, 404, { error: "Unknown turn" })
      if (req.method !== "POST") return reply(res, 405, {})
      let raw = ""
      for await (const chunk of req) {
        raw += String(chunk)
        if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("MCP body too large")
      }
      const rpc = rpcSchema.parse(JSON.parse(raw)); rpcId = rpc.id
      if (rpc.id === undefined) { res.writeHead(202); res.end(); return }
      let result: unknown
      const tools = run.request.tool_choice?.type === "none" ? [] : run.request.tools
      if (rpc.method === "initialize") result = { protocolVersion: rpc.params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "meridian-client-tools", version: "1" } }
      else if (rpc.method === "tools/list") result = { tools: tools.map(t => ({ name: t.name, description: t.description ?? t.name, inputSchema: t.input_schema })) }
      else if (rpc.method === "tools/call") {
        const params = toolParams.parse(rpc.params)
        if (!tools.some(tool => tool.name === params.name)) throw new Error("Unknown client tool")
        const value = await run.call(params.name, params.arguments)
        result = { content: typeof value.content === "string" ? [{ type: "text", text: value.content }] : value.content?.length ? value.content : [{ type: "text", text: "" }], isError: value.is_error ?? false }
      } else return reply(res, 200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } })
      reply(res, 200, { jsonrpc: "2.0", id: rpc.id, result })
    } catch (error) { reply(res, 200, { jsonrpc: "2.0", id: rpcId ?? null, error: { code: -32603, message: String(error) } }) }
  }
  close(): Promise<void> {
    this.closing ??= this.closeOnce()
    return this.closing
  }
  private async closeOnce(): Promise<void> {
    this.draining = true
    const runs = [...this.runs.values()]
    for (const run of runs) run.abort(new AntigravityError("Antigravity backend stopped", 503, "api_error"))
    await Promise.all(runs.map(run => run.settled))
    if (this.server) {
      const stopped = new Promise<void>((resolve, reject) => this.server!.close(error => error && "code" in error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()))
      this.server.closeAllConnections()
      await stopped
    }
  }
}

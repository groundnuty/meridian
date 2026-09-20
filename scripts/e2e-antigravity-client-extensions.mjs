// Actual client extensions, approvals and questions over the official subscription CLI.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { once } from 'node:events'
import { preflightFault } from './lib-antigravity-preflight-fault.mjs'
import { startProxyServer } from '../dist/server.js'

const lostAnswer = process.env.E2E_AGY_LOST_ANSWER === '1'
const disconnect = process.env.E2E_AGY_DISCONNECT === '1' || lostAnswer
let completedWire, recoveredWire
const wireSummary = wire => {
  const events = wire.trim().split('\n\n').map(frame => frame.split('\n').find(line => line.startsWith('data: '))).filter(Boolean).map(line => JSON.parse(line.slice(6)))
  assert.equal(events.at(-1).type, 'message_stop')
  assert(!events.some(event => event.content_block?.type === 'tool_use'), 'Lost answer must be terminal text')
  return { id: events.find(event => event.type === 'message_start').message.id, text: events.filter(event => event.delta?.type === 'text_delta').map(event => event.delta.text).join(''), terminal: events.find(event => event.type === 'message_delta') }
}
let dropped = false
const client = process.env.E2E_CLIENT || 'pi'
assert(['pi', 'opencode'].includes(client))
const binary = client === 'pi' ? process.env.E2E_PI_BIN || 'pi' : process.env.E2E_OPENCODE_BIN || 'opencode'
let executable = process.env.MERIDIAN_AGY_PATH || 'agy'
const version = bin => { const r = spawnSync(bin, ['--version'], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return (r.stdout || r.stderr).trim() }
const root = await mkdtemp(join(tmpdir(), `meridian-agy-${client}-extensions-`))
console.log(`Artifacts: ${root}`)
const probeFault = process.env.E2E_AGY_PREFLIGHT_TIMEOUT === '1' ? await preflightFault(root, executable) : undefined
if (probeFault) executable = probeFault.executable
const config = join(root, 'config'), project = join(root, 'project'), auditPath = join(root, 'audit.jsonl')
await mkdir(config); await mkdir(project); await writeFile(auditPath, '')
const modelID = process.env.E2E_AGY_MODEL || 'gemini-3.8-flash-low'
const receipt = `CLIENT_${randomUUID()}`
const env = { ...process.env }
for (const key of Object.keys(env)) if (/^(OPENCODE_|MERIDIAN_|CLAUDE_PROXY_|ANTHROPIC_|CLAUDE_|GEMINI_API_KEY|GOOGLE_API_KEY)/.test(key)) delete env[key]
env.MERIDIAN_EXTENSION_AUDIT = auditPath; env.MERIDIAN_EXTENSION_RECEIPT = receipt
const report = { disconnect, lostAnswer, client, clientVersion: version(binary), cliVersion: version(executable), modelID, platform: process.platform, node: process.version, passed: [] }
const requests = [], events = [], apiLog = [], httpErrors = []
let proxy, relay, child, exited = false, stdout = '', stderr = ''
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const audit = async () => (await readFile(auditPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const mark = text => { report.passed.push(text); console.log('PASS', text) }
function launch(args) {
  child = spawn(binary, args, { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
  child.once('error', error => { stderr += String(error); exited = true })
  child.once('close', () => { exited = true })
}
async function until(fn, label, timeout = 180000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await fn(); if (value) return value; assert(!exited, stderr); await delay(100) }
  throw new Error(`Timeout: ${label}; ${stderr}`)
}
try {
  proxy = await startProxyServer({ backend: 'antigravity', port: 0, silent: true, antigravity: { executable, allowToolBridge: true, pendingToolTimeoutMs: 5000, ...(disconnect ? { statePath: join(root, 'state.sqlite') } : {}) } })
  if (!proxy.server.listening) await once(proxy.server, 'listening')
  const address = proxy.server.address(); assert(address && typeof address !== 'string')
  const upstream = `http://127.0.0.1:${address.port}`
  relay = createServer(async (req, res) => {
    const abort = new AbortController(); res.once('close', () => { if (!res.writableFinished) abort.abort() })
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw) { requests.push(JSON.parse(raw)); await writeFile(join(root, 'requests.json'), JSON.stringify(requests, null, 2)) }
      const response = await fetch(upstream + req.url, { method: req.method, headers: { 'content-type': 'application/json' }, body: raw || undefined, signal: abort.signal })
      if (!response.ok) { const text = await response.clone().text(); httpErrors.push({ status: response.status, text }); console.log('HTTP', response.status, text) }
      const latest = raw ? JSON.parse(raw).messages?.at(-1)?.content : undefined
      if (disconnect && !dropped && response.ok && Array.isArray(latest) && latest.some(block => block.type === 'tool_result' && JSON.stringify(block.content).includes(receipt))) {
        assert.equal((await audit()).filter(event => event.event === 'executed').length, 1)
        // Headers arrive only after the backend accepts the completed tool result.
        // Consume the first SSE frame, then sever delivery before the client sees it.
        if (lostAnswer) {
          completedWire = wireSummary(await response.text())
          assert(completedWire.text.includes(receipt))
          dropped = true
          res.destroy()
          console.log('Injected lost completed answer after consuming message_stop')
          return
        }
        const reader = response.body.getReader()
        const first = await reader.read()
        assert(!first.done, 'Fault must interrupt an actual upstream response')
        dropped = true
        report.droppedToolIds = latest.filter(block => block.type === 'tool_result').map(block => block.tool_use_id)
        res.destroy()
        await reader.cancel('Injected client connection loss')
        reader.releaseLock()
        console.log('Injected disconnect after completed tool result acceptance')
        return
      }
      if (lostAnswer && response.headers.get('x-meridian-response-replayed') === 'true') {
        recoveredWire = wireSummary(await response.clone().text())
        assert.deepEqual(recoveredWire, completedWire, 'Retry must return the identical saved answer, ID and usage')
      }
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') })
      Readable.fromWeb(response.body).on('error', error => res.destroy(error)).pipe(res)
    } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(String(error)) }
  })
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve))
  const relayAddress = relay.address(); assert(relayAddress && typeof relayAddress !== 'string')
  const baseUrl = `http://127.0.0.1:${relayAddress.port}`
  async function expireApproval() {
    // Simulate a human taking longer than the configured CLI tool wait. The
    // completed client result must recover without asking the client to run twice.
    await delay(5500)
    const response = await fetch(upstream + '/health', { signal: AbortSignal.timeout(20000) })
    assert(response.ok)
    assert.equal((await response.json()).pendingToolProcesses, 0, 'Pending CLI owner must expire before approval')
    assert.equal((await audit()).filter(e => e.event === 'executed').length, 1, 'Waiting for approval must not execute the client tool')
  }
  if (client === 'pi') {
    env.PI_CODING_AGENT_DIR = config; env.PI_OFFLINE = '1'; env.PI_TELEMETRY = '0'
    await writeFile(join(config, 'models.json'), JSON.stringify({ providers: { 'meridian-agy': { baseUrl, apiKey: 'fixture', api: 'anthropic-messages', models: [{ id: modelID, name: modelID, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }))
    await writeFile(join(config, 'settings.json'), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }))
    launch(['--provider', 'meridian-agy', '--model', modelID, '--thinking', 'off', '--mode', 'rpc', '--no-session', '--no-builtin-tools', '--no-extensions', '-e', fileURLToPath(new URL('./fixtures/agy-pi-extension.js', import.meta.url)), '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes'])
    let buffer = ''
    child.stdout.on('data', value => {
      buffer += value
      while (buffer.includes('\n')) { const at = buffer.indexOf('\n'), line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (line.trim()) events.push(JSON.parse(line)) }
    })
    const send = value => child.stdin.write(JSON.stringify(value) + '\n')
    async function command(type, fields = {}) {
      const id = randomUUID(); send({ id, type, ...fields })
      const reply = await until(() => events.find(event => event.type === 'response' && event.id === id), type)
      assert(reply.success, JSON.stringify(reply)); return reply.data
    }
    async function turn(prompt, dialog, interrupted = false) {
      const start = events.length
      await command('prompt', { message: prompt })
      if (dialog) {
        const request = await until(() => {
          const current = events.slice(start)
          const dialog = current.find(event => event.type === 'extension_ui_request' && ['confirm', 'select'].includes(event.method))
          assert(dialog || !current.some(event => event.type === 'agent_end'), 'Pi ended without the requested dialog: ' + JSON.stringify(current))
          return dialog
        }, 'extension dialog')
        await dialog(request, send)
      }
      const end = await until(() => events.slice(start).find(event => event.type === 'agent_end'), 'agent end')
      if (!interrupted) assert(!end.messages?.some(message => message.stopReason === 'error'), JSON.stringify(end))
      else report.interruptedClientResult = end
      const answer = end.messages?.findLast(message => message.role === 'assistant')
      return answer?.content.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
    }
    await command('get_state')
    let allowed = await turn('Call client_receipt exactly once with label ORIGINAL. Report the returned value. Do not use any other tools.', async (request, send) => {
      assert.equal(request.method, 'confirm'); assert.equal((await audit()).filter(e => e.event === 'executed').length, 0)
      send({ type: 'extension_ui_response', id: request.id, confirmed: true })
    }, disconnect)
    if (disconnect) {
      assert(dropped, 'Connection fault must be injected')
      assert(allowed.includes(receipt), 'Pi must automatically retry the interrupted continuation: ' + allowed)
      mark('Pi automatically recovers accepted-result disconnect without repeating the client action')
    }
    assert(allowed.includes(`CLIENT_PATCHED:${receipt}`), allowed)
    assert.equal((await audit()).filter(e => e.event === 'executed').length, 1)
    mark('real Pi extension approval, argument transform and custom tool execution')
    const denied = await turn('Call client_receipt once with label DENIED. If permission is denied, report CLIENT_DENIED and stop. Never retry or use another tool.', async (request, send) => send({ type: 'extension_ui_response', id: request.id, confirmed: false }))
    assert(denied.includes('CLIENT_DENIED'), denied)
    assert.equal((await audit()).filter(e => e.event === 'executed').length, 1)
    mark('real Pi denial reaches the model without executing the custom tool')
    const answer = await turn('Call client_question exactly once. Report the selected answer.', async (request, send) => { assert.equal(request.method, 'select'); send({ type: 'extension_ui_response', id: request.id, value: 'SECOND' }) })
    assert(answer.includes('SECOND'), answer); mark('real Pi extension question and answer round trip')
    const cancelled = await turn('Call client_question once. If cancelled, report CLIENT_CANCELLED and stop.', async (request, send) => send({ type: 'extension_ui_response', id: request.id, cancelled: true }))
    assert(cancelled.includes('CLIENT_CANCELLED'), cancelled); mark('real Pi extension question cancellation')
    await turn('Call install_extra exactly once, then stop. Do not call late_receipt until the next user turn.')
    const dynamic = await turn('Now call late_receipt exactly once and report its returned receipt. Do not use client_receipt.')
    assert(dynamic.includes(receipt), dynamic)
    assert.equal((await audit()).filter(e => e.event === 'late-executed').length, 1)
    mark('real Pi dynamically registered tool becomes usable on the next turn')
    const delayed = await turn('Call client_receipt exactly once with label DELAYED and report its returned value.', async (request, send) => {
      await expireApproval()
      send({ type: 'extension_ui_response', id: request.id, confirmed: true })
    })
    assert(delayed.includes(receipt), delayed)
    assert.equal((await audit()).filter(e => e.event === 'executed').length, 2)
    mark('real Pi delayed approval recovers after CLI expiry with one client execution')
  } else {
    for (const kind of ['CONFIG', 'DATA', 'CACHE', 'STATE']) env[`XDG_${kind}_HOME`] = join(root, kind.toLowerCase())
    env.HOME = join(root, 'client-home'); await mkdir(env.HOME)
    env.OPENCODE_CONFIG_DIR = config; env.OPENCODE_DISABLE_AUTOUPDATE = '1'; env.OPENCODE_SERVER_PASSWORD = randomUUID()
    await mkdir(join(config, 'plugins'))
    await copyFile(new URL('./fixtures/agy-opencode-plugin.js', import.meta.url), join(config, 'plugins', 'fixture.js'))
    await writeFile(join(config, 'opencode.json'), JSON.stringify({ model: `meridian-agy/${modelID}`, small_model: `meridian-agy/${modelID}`, enabled_providers: ['meridian-agy'], share: 'disabled', permission: { '*': 'deny', question: 'allow', client_receipt: 'ask', client_denied: 'ask', client_blocked: 'allow' }, provider: { 'meridian-agy': { npm: '@ai-sdk/anthropic', options: { baseURL: baseUrl + '/v1', apiKey: 'fixture' }, models: { [modelID]: { name: modelID, limit: { context: 128000, output: 4096 }, temperature: false, reasoning: false, tool_call: true } } } } }))
    launch(['serve', '--hostname', '127.0.0.1', '--port', '0'])
    const server = await until(() => /http:\/\/127\.0\.0\.1:\d+/.exec(stdout)?.[0], 'OpenCode server', 30000)
    async function api(path, body) {
      const response = await fetch(server + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(180000) })
      const text = await response.text(); apiLog.push({ path, body, status: response.status, response: text })
      assert(response.ok, `${path}: ${response.status}: ${text}`); return text ? JSON.parse(text) : undefined
    }
    await writeFile(join(root, 'openapi.json'), JSON.stringify(await api('/doc')))
    const session = await api('/session', { title: 'Client extension acceptance' })
    const path = `/session/${session.id}`
    async function turn(text, interact, interrupted = false) {
      const previous = await api(path + '/message')
      await api(path + '/prompt_async', { model: { providerID: 'meridian-agy', modelID }, parts: [{ type: 'text', text }] })
      if (interact) await interact(api)
      return until(async () => {
        const messages = await api(path + '/message')
        const last = messages.at(-1)
        if (messages.length <= previous.length || last?.info.role !== 'assistant' || !last.info.time?.completed || (await api('/session/status'))[session.id]?.type === 'busy') return
        if (!interrupted) assert(!last.info.error, JSON.stringify(last))
        else report.interruptedClientResult = last
        return JSON.stringify(last)
      }, 'OpenCode turn')
    }
    let allowed = await turn('Call client_receipt exactly once and report its entire returned value.', async api => {
      const request = await until(async () => (await api('/permission')).find(p => p.sessionID === session.id && p.permission === 'client_receipt'), 'permission prompt')
      assert.equal((await audit()).filter(e => e.event === 'executed').length, 0)
      await api(`/permission/${request.id}/reply`, { reply: 'once' })
    }, disconnect)
    if (disconnect) {
      assert(dropped, 'Connection fault must be injected')
      assert(allowed.includes(receipt), 'OpenCode must automatically retry the interrupted continuation: ' + allowed)
      mark('OpenCode automatically recovers accepted-result disconnect without repeating the client action')
    }
    assert(allowed.includes(receipt) && allowed.includes('CLIENT_PLUGIN_AFTER'), allowed)
    assert.equal((await audit()).filter(e => e.event === 'executed').length, 1)
    mark('real OpenCode plugin tool, permission approval and result hook')
    const denied = await turn('Call client_denied once. If permission is denied, report CLIENT_DENIED and stop. Never retry or use another tool.', async api => {
      const request = await until(async () => (await api('/permission')).find(p => p.sessionID === session.id && p.permission === 'client_denied'), 'denial prompt')
      await api(`/permission/${request.id}/reply`, { reply: 'reject' })
    })
    assert(denied.includes('rejected') || denied.includes('CLIENT_DENIED'), denied)
    const resumed = await turn('Report CLIENT_DENIED to acknowledge the rejected action. Do not call any tools.')
    assert(resumed.includes('CLIENT_DENIED'), resumed)
    assert.equal((await audit()).filter(e => e.event === 'executed').length, 1)
    mark('real OpenCode permission rejection without tool execution')
    const blocked = await turn('Call client_blocked once. If the plugin blocks it, report CLIENT_PLUGIN_DENIED and stop. Never retry or use another tool.')
    assert(blocked.includes('CLIENT_PLUGIN_DENIED'), blocked)
    assert.equal((await audit()).filter(e => e.event === 'executed').length, 1)
    mark('real OpenCode plugin rejection reaches the model')
    for (const cancelled of [false, true]) {
      const answer = await turn('Use question to ask the user to choose FIRST or SECOND. Report their answer; if rejected, report CLIENT_CANCELLED and stop.', async api => {
        const request = await until(async () => (await api('/question')).find(p => p.sessionID === session.id), 'question prompt')
        await api(`/question/${request.id}/${cancelled ? 'reject' : 'reply'}`, cancelled ? {} : { answers: [['SECOND']] })
      })
      if (cancelled) {
        assert(JSON.parse(answer).parts.some(part => part.type === 'tool' && part.tool === 'question' && part.state.status === 'error' && part.state.error === 'The user dismissed this question'), answer)
        assert((await turn('Report CLIENT_CANCELLED to acknowledge the rejected question. Do not call tools.')).includes('CLIENT_CANCELLED'))
      } else assert(answer.includes('SECOND'), answer)
      mark(`real OpenCode question ${cancelled ? 'cancellation' : 'answer round trip'}`)
    }
    const delayed = await turn('Call client_receipt exactly once and report its entire returned value.', async api => {
      const request = await until(async () => (await api('/permission')).find(p => p.sessionID === session.id && p.permission === 'client_receipt'), 'delayed permission')
      await expireApproval()
      await api(`/permission/${request.id}/reply`, { reply: 'once' })
    })
    assert(delayed.includes(receipt), delayed)
    assert.equal((await audit()).filter(e => e.event === 'executed').length, 2)
    mark('real OpenCode delayed approval recovers after CLI expiry with one client execution')
    const telemetry = await (await fetch(upstream + '/telemetry/requests')).json()
    assert(telemetry.some(entry => entry.continuation === 'client-context-replay'), 'Plugin context change must replay directly, without waiting for expiry/retry')
  }
  const results = requests.flatMap(r => r.messages || []).flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.type === 'tool_result')
  assert(results.some(r => JSON.stringify(r.content).includes(receipt)), 'Private receipt must enter via actual client tool_result')
  assert(results.some(r => r.is_error), 'Denial must enter as a client tool error')
  if (probeFault) {
    const attempts = (await readFile(probeFault.audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(attempts.filter(event => event.event === 'config-stall-start').length, 1)
    const verified = attempts.findIndex(event => event.event === 'config-forwarded' && event.code === 0)
    const model = attempts.findIndex(event => event.event === 'model-start')
    assert(verified > 0 && model > verified, 'A fresh official configuration check must succeed before generation')
    report.preflightAttempts = attempts
    mark('official configuration timeout recovers before any client generation')
  }
  if (disconnect) assert(dropped)
  if (lostAnswer) { assert(recoveredWire, 'Client must recover through the saved-answer path'); mark('Lost completed answer replayed with identical ID/content/usage and no new model invocation') }
  assert.deepEqual(httpErrors, [], 'A green client retry must not hide bridge errors')
  assert.equal(version(executable), report.cliVersion)
  report.requests = requests.length
  console.log(JSON.stringify(report, null, 2))
} catch (error) { report.error = String(error); throw error }
finally {
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  await writeFile(join(root, 'events.json'), JSON.stringify(events, null, 2))
  await writeFile(join(root, 'api.json'), JSON.stringify(apiLog, null, 2))
  await writeFile(join(root, 'http-errors.json'), JSON.stringify(httpErrors, null, 2))
  await writeFile(join(root, 'requests.json'), JSON.stringify(requests, null, 2))
  await writeFile(join(root, 'client.stdout'), stdout); await writeFile(join(root, 'client.stderr'), stderr)
  if (child && !exited) { child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 1000); await once(child, 'close').finally(() => clearTimeout(timer)) }
  await proxy?.close()
  if (relay) { relay.closeAllConnections(); await new Promise(resolve => relay.close(resolve)) }
}

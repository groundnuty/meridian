#!/usr/bin/env node
// Deterministic official-CLI protocol fixture. Never contacts a model service.
const { spawnSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const args = process.argv.slice(2)
const emit = value => process.stdout.write(JSON.stringify(value) + '\n')
async function main() {
  if (args[0] === '--version') return console.log(process.env.AGY_FIXTURE_VERSION || '1.2.7')
  if (args[0] === 'models') return console.log('fixture-model\tFixture Model\nfixture-model-high\tFixture High')
  let prompt = args[args.indexOf('-p') + 1]
  if (args.includes('--input-format')) {
    let input = ''; for await (const chunk of process.stdin) input += chunk
    prompt = JSON.parse(input).message.content
  }
  if (prompt === '/config') return emit({ command: { data: { config: { modelProvider: process.env.AGY_FIXTURE_API ? 'gemini' : '', useG1Credits: false } } } })
  if (prompt === '/usage') return emit({command:{data:{groups:[{name:'Gemini Models',buckets:[{id:'gemini-5h',window:'5h',remaining_fraction:0.75,reset_time:'2099-01-01T00:00:00Z'}]}]}}})
  if (prompt.includes('POLICY_PROBE')) {
    const check = (input, decision) => {
      const child = spawnSync(process.execPath, ['policy.cjs'], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' })
      if (child.status !== 0 || JSON.parse(child.stdout).decision !== decision) throw new Error('Policy mismatch: ' + child.stdout)
    }
    check({toolCall:{name:'view_file',args:{AbsolutePath:'/etc/passwd'}}}, 'deny')
    check({toolCall:{name:'run_command',args:{CommandLine:'id'}}}, 'deny')
    check({toolCall:{name:'call_mcp_tool',args:{ServerName:'other',ToolName:'lookup'}}}, 'deny')
    check({toolCall:{name:'call_mcp_tool',args:{ServerName:'meridian_client',ToolName:'unknown'}}}, 'deny')
    check('invalid JSON', 'deny')
    check({toolCall:{name:'call_mcp_tool',args:{ServerName:'meridian_client',ToolName:'lookup'}}}, 'allow')
  }
  if (prompt.includes('IMAGE_PROBE')) {
    const paths = JSON.parse(readFileSync('attachment-paths.json', 'utf8'))
    if (paths.length !== 1 || !prompt.includes(paths[0]) || prompt.includes('iVBORw0KGgo')) throw new Error('Image reference missing or bytes leaked')
    for (const [path, decision] of [[paths[0], 'allow'], ['/etc/passwd', 'deny'], [paths[0] + '/../policy.cjs', 'deny']]) {
      const result = spawnSync(process.execPath, ['policy.cjs'], { input: JSON.stringify({ toolCall: { name: 'view_file', args: { AbsolutePath: path } } }), encoding: 'utf8' })
      if (JSON.parse(result.stdout).decision !== decision) throw new Error('Image policy mismatch')
    }
  }
  if (prompt.includes('EFFORT_PROBE') && args[args.indexOf('--effort') + 1] !== 'high') throw new Error('Native effort flag missing')
  emit({ event: 'init' })
  if (prompt.includes('RATE_LIMIT')) return emit({event:'result',result:{status:'ERROR',error:'Quota exhausted; retry in 45 seconds'}})
  if (prompt.includes('HANG')) { setInterval(() => {}, 1000); return }
  if (prompt.includes('MALFORMED')) { console.log('not JSON'); return }
  if (prompt.includes('DENIED')) return emit({ event: 'result', result: { status: 'SUCCESS', denied_actions: [{ action: 'mcp' }] } })
  const config = JSON.parse(readFileSync('.agents/mcp_config.json', 'utf8'))
  const url = config.mcpServers.meridian_client.serverUrl
  let nextId = 0
  const rpc = async (method, params, retryId) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: retryId ?? ++nextId, method, params }) })
    const value = await response.json()
    if (value.error) throw new Error(value.error.message)
    return value.result
  }
  const { tools } = await rpc('tools/list')
  if (prompt.includes('UNICODE_CHUNKS')) {
    const { request } = require('node:http')
    const input = { key: 'café/你好/🧪.txt' }
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method: 'tools/call', params: { name: tools[0].name, arguments: input } }))
    const split = body.indexOf(Buffer.from('🧪')) + 2
    const result = await new Promise((resolve, reject) => {
      const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
        let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve(JSON.parse(text)))
      })
      req.on('error', reject)
      req.write(body.subarray(0, split))
      setTimeout(() => req.end(body.subarray(split)), 50)
    })
    if (result.error) throw new Error(result.error.message)
    emit({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'UNICODE_OK' } })
    return emit({ event: 'result', result: { status: 'SUCCESS' } })
  }
  if (prompt.includes('INVALID_TOOL_ARGS')) {
    let rejected = false
    try { await rpc('tools/call', { name: tools[0].name, arguments: { key: 7 } }) }
    catch (error) { if (!String(error).includes('Invalid arguments')) throw error; rejected = true }
    if (!rejected) throw new Error('Invalid arguments reached the client')
  }
  let answer = 'READY'
  if (tools.length && !prompt.includes("SKIP_TOOLS")) {
    emit({ event: 'step_update', step_update: { state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 100, output_tokens: 5 } } })
    const calls = Array.from({ length: prompt.includes('PARALLEL2') ? 2 : 1 }, (_, n) => rpc('tools/call', { name: tools[0].name, arguments: { key: `probe${n}` } }))
    if (prompt.includes('RPC_RETRY')) calls.push(rpc('tools/call', {name:tools[0].name,arguments:{key:'probe0'}},2))
    const results = await Promise.all(calls)
    if (prompt.includes('STEERING')) {
      const followup = JSON.parse(results[0].content[0].text).meridian_client_followup
      answer = JSON.stringify(followup)
    } else answer = results.map(result => (result.isError ? 'FAILED:' : '') + ((value) => typeof value === 'string' ? value : value.map(b => b.text).join(''))(JSON.parse(result.content[0].text).meridian_client_result)).join('|')
  }
  emit({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: answer } })
  emit({ event: 'step_update', step_update: { state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 120, output_tokens: 10, cache_read_tokens: 20 } } })
  const schemaPath = args.includes('--json-schema') && args[args.indexOf('--json-schema') + 1]
  if (schemaPath) JSON.parse(readFileSync(schemaPath, 'utf8'))
  emit({ event: 'result', result: { status: 'SUCCESS', ...(schemaPath && !prompt.includes('MISSING_STRUCTURED') ? { structured_output: prompt.includes('BAD_STRUCTURED') ? { output: { answer } } : { answer } } : {}) } })
  if (prompt.includes('BAD_EXIT')) process.exitCode = 1
  if (prompt.includes('LINGER')) setInterval(() => {}, 1000)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
